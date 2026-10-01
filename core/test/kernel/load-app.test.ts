/**
 * Tests for the kernel loader: the `jsails.config.ts` root (`defineApp`, its
 * environment and its config function), the static scan with its located
 * refusals, the activation literal, the legacy root, and `createLoadedApp`.
 *
 * Fixtures are written under the compiled test tree, in a directory that is
 * its own package (`load-app-fixtures`) with `node_modules/jsails` linked to
 * the built framework, so a config root resolves `jsails/kernel` as an app
 * does: through `node_modules`, not as a self-reference of the `jsails`
 * package (which the scan refuses).
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { AppConfigError } from '../../src/app/config/errors.js';
import { activationModeOf } from '../../src/kernel/resolve-plugins.js';
import { defineApp, isAppDefinition } from '../../src/kernel/define-app.js';
import { createLoadedApp, isLoadedApp, loadApp } from '../../src/kernel/load-app.js';
import { resolveEnvironment } from '../../src/environment/resolve.js';
import { EnvironmentErrors } from '../../src/environment/errors.js';
import { ConfigErrors } from '../../src/plugins/contract/errors.js';
import { envVar } from '../../src/plugins/contract/option-schemas.js';

const fixturesRoot = mkdtempSync(
  join(fileURLToPath(new URL('.', import.meta.url)), 'load-app-fixture-'),
);
after(() => rmSync(fixturesRoot, { recursive: true, force: true }));
writeFileSync(
  join(fixturesRoot, 'package.json'),
  JSON.stringify({ name: 'load-app-fixtures', private: true, type: 'module' }),
);
mkdirSync(join(fixturesRoot, 'node_modules'));
// A junction needs no privilege on Windows; the type is ignored elsewhere.
symlinkSync(
  fileURLToPath(new URL('../../../', import.meta.url)),
  join(fixturesRoot, 'node_modules', 'jsails'),
  'junction',
);

let sequence = 0;

/** A fresh project directory holding `files` (path to source). */
function project(files: Readonly<Record<string, string>>): string {
  const dir = join(fixturesRoot, `case-${sequence++}`);
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), source);
  }
  return dir;
}

const HEAD = "import { defineApp } from 'jsails/kernel';\n";

/** The 1-based line and column of the first `marker` in `source`. */
function positionOf(source: string, marker: string): [number, number] {
  const before = source.slice(0, source.indexOf(marker)).split('\n');
  return [before.length, (before.at(-1)?.length ?? 0) + 1];
}

function load(dir: string, env: Readonly<Record<string, string>> = {}) {
  return loadApp({ configPath: 'jsails.config.ts', cwd: dir, env });
}

/** Assert `promise` rejects with the located `config.<code>` error at `line:column`. */
async function rejectsAt(
  promise: Promise<unknown>,
  code:
    | 'outside_graph'
    | 'non_erasable_syntax'
    | 'activation_not_literal'
    | 'activation_repeated'
    | 'invalid_syntax',
  path: string,
  line: number,
  column: number,
  detail?: string,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(ConfigErrors.is(error, code), String(error));
    const context = error.context as Record<string, unknown>;
    assert.equal(context['path'], path);
    assert.equal(context['line'], line);
    assert.equal(context['column'], column);
    if (detail !== undefined) {
      assert.equal(context['problem'] ?? context['construct'], detail);
    }
    return true;
  });
}

describe('loadApp: the jsails.config.ts root', () => {
  it('loads a defineApp module, its config/ modules and its parsed environment', async () => {
    const dir = project({
      'jsails.config.ts': `${HEAD}import { envVar } from 'jsails/kernel';
import { listen } from './config/listen.ts';
type Port = number;
const fallback: Port = 3000;
export default defineApp({
  env: { APP_PORT: envVar.integer() },
  config: (env) => ({ host: listen.host, port: env.APP_PORT ?? fallback }),
});
`,
      'config/listen.ts': `import { base } from './base.ts';\nexport const listen = { host: base };\n`,
      'config/base.ts': `export const base: string = '0.0.0.0';\n`,
    });
    const app = await load(dir, { APP_PORT: '4100' });
    assert.ok(isLoadedApp(app));
    assert.equal(app.config.host, '0.0.0.0');
    assert.equal(app.config.port, 4100);
    assert.equal(app.config.rootDir, dir);
    assert.equal(Object.isFrozen(app), true);
    assert.equal(activationModeOf(app), 'locked');
  });

  it('refuses app code, absolute paths, URLs, builtins, dynamic imports and require', async () => {
    const cases: readonly [string, string, number, number][] = [
      ["import user from './models/user.ts';\n", 'relative_import', 2, 1],
      ["export * from '../outside.ts';\n", 'relative_import', 2, 1],
      ["import x from '/etc/config.ts';\n", 'absolute_import', 2, 1],
      ["import x from 'https://example.com/x.ts';\n", 'url_import', 2, 1],
      ["import { readFileSync } from 'node:fs';\n", 'builtin_import', 2, 1],
      ["import fs from 'fs';\n", 'builtin_import', 2, 1],
      ["const x = await import('zod');\n", 'dynamic_import', 2, 17],
      ["const x = require('zod');\n", 'require_call', 2, 11],
      ["import x from './config/missing.ts';\n", 'missing_module', 2, 1],
      ["import { User } from '#app/models/user.ts';\n", 'subpath_import', 2, 1],
      ["export { User } from 'load-app-fixtures/models/user.ts';\n", 'self_import', 2, 1],
      ["import 'load-app-fixtures';\n", 'self_import', 2, 1],
    ];
    for (const [line, problem, row, column] of cases) {
      const dir = project({
        'jsails.config.ts': `${HEAD}${line}export default defineApp({ config: () => ({}) });\n`,
      });
      await rejectsAt(load(dir), 'outside_graph', 'jsails.config.ts', row, column, problem);
    }
  });

  it('never runs app code reached through a subpath import or a self-reference', async () => {
    for (const specifier of ['#app/models/user.ts', 'self-app/models/user.ts']) {
      const dir = project({
        'package.json': JSON.stringify({
          name: 'self-app',
          type: 'module',
          imports: { '#app/*': './*' },
          exports: { './*': './*' },
        }),
        'models/user.ts': 'globalThis.__loadAppRanUser = true;\nexport const User = 1;\n',
        'jsails.config.ts': `${HEAD}import { User } from '${specifier}';\nexport default defineApp({ config: () => ({ port: User }) });\n`,
      });
      await assert.rejects(load(dir), (error: unknown) => ConfigErrors.is(error, 'outside_graph'));
      assert.equal((globalThis as { __loadAppRanUser?: boolean }).__loadAppRanUser, undefined);
    }
  });

  it('locates a refusal inside a config/ module by that module', async () => {
    const dir = project({
      'jsails.config.ts': `${HEAD}import { x } from './config/a.ts';\nexport default defineApp({ config: () => ({ port: x }) });\n`,
      'config/a.ts': `export const x = 1;\n\nimport '../app/boot.ts';\n`,
    });
    await rejectsAt(load(dir), 'outside_graph', 'config/a.ts', 3, 1, 'relative_import');
  });

  it('refuses syntax type stripping cannot erase', async () => {
    const cases: readonly [string, string, number, number][] = [
      ['enum Mode { A }\n', 'enum', 2, 1],
      ['namespace N { export const a = 1; }\n', 'namespace', 2, 1],
      ['class C { constructor(private a: number) {} }\n', 'parameter_property', 2, 23],
      ["import fs = require('zod');\n", 'import_equals', 2, 1],
      ['function d(..._: unknown[]) {}\nclass K { @d m() {} }\n', 'decorator', 3, 11],
    ];
    for (const [line, construct, row, column] of cases) {
      const dir = project({
        'jsails.config.ts': `${HEAD}${line}export default defineApp({ config: () => ({}) });\n`,
      });
      await rejectsAt(load(dir), 'non_erasable_syntax', 'jsails.config.ts', row, column, construct);
    }
  });

  it('accepts erasable TypeScript: types, declare blocks and type-only imports', async () => {
    const dir = project({
      'jsails.config.ts': `${HEAD}import type { User } from './models/user.ts';
declare namespace Ambient { const a: number; }
declare enum Ambient2 { A }
interface Shape { readonly port: number }
const shape: Shape = { port: 4000 };
export type { User };
export default defineApp({ config: () => ({ port: shape.port }) });
`,
    });
    assert.equal((await load(dir)).config.port, 4000);
  });

  it('reports a syntax error at its place without echoing source', async () => {
    const dir = project({
      'jsails.config.ts': `${HEAD}const secret = 'supersecret-password' +;\nexport default defineApp({ config: () => ({}) });\n`,
    });
    await assert.rejects(load(dir), (error: unknown) => {
      assert.ok(ConfigErrors.is(error, 'invalid_syntax'));
      assert.equal(error.context.line, 2);
      assert.doesNotMatch(error.message, /supersecret/);
      return true;
    });
  });

  it('refuses a root that does not default-export defineApp', async () => {
    const dir = project({ 'jsails.config.ts': 'export default { port: 3000 };\n' });
    await assert.rejects(load(dir), (error: unknown) => {
      assert.ok(ConfigErrors.is(error, 'invalid_app_definition'));
      assert.equal(error.context.path, 'jsails.config.ts');
      return true;
    });
  });

  it('reports an invalid environment by variable and rule, never by value', async () => {
    const dir = project({
      'jsails.config.ts': `${HEAD}import { envVar } from 'jsails/kernel';
export default defineApp({
  env: { APP_PORT: envVar.integer(), APP_URL: envVar.url() },
  config: (env) => ({ port: env.APP_PORT }),
});
`,
    });
    await assert.rejects(
      load(dir, { APP_PORT: 'supersecret-password', APP_URL: 'not a url' }),
      (error: unknown) => {
        assert.ok(ConfigErrors.is(error, 'invalid_app_env'));
        assert.equal(error.context.variable, 'APP_PORT');
        assert.equal(error.context.count, 2);
        assert.deepEqual(
          error.payload.issues.map((issue) => issue.path[0]),
          ['APP_PORT', 'APP_URL'],
        );
        assert.doesNotMatch(error.message, /supersecret|not a url/);
        return true;
      },
    );
  });

  it('refuses a config function that returns a promise, leaving no unhandled rejection', async () => {
    for (const body of [
      "async () => ({ port: 8080, server: { origin: 'https://example.test' } })",
      "async () => { throw new Error('supersecret-password'); }",
    ]) {
      const dir = project({
        'jsails.config.ts': `${HEAD}export default defineApp({ config: (${body}) as never });\n`,
      });
      await assert.rejects(load(dir), (error: unknown) => {
        assert.ok(ConfigErrors.is(error, 'async_config'));
        assert.equal(error.context.path, 'jsails.config.ts');
        assert.doesNotMatch(error.message, /supersecret/);
        return true;
      });
    }
  });

  it('reports a throwing config function without its message', async () => {
    const dir = project({
      'jsails.config.ts': `${HEAD}export default defineApp({
  config: () => { throw new Error('supersecret-password'); },
});
`,
    });
    await assert.rejects(load(dir), (error: unknown) => {
      assert.ok(ConfigErrors.is(error, 'config_failed'));
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.message, /supersecret/);
      return true;
    });
  });

  it('applies the listen overrides from the environment it is handed only', async () => {
    const dir = project({
      'jsails.config.ts': `${HEAD}export default defineApp({ config: () => ({ port: 3000 }) });\n`,
    });
    assert.equal((await load(dir, { JSAILS_PORT: '4555' })).config.port, 4555);
    assert.equal((await load(dir)).config.port, 3000);
  });
});

describe('loadApp: the environment of a process the bin did not start', () => {
  const declared = `${HEAD}import { envVar } from 'jsails/kernel';
export default defineApp({
  env: { APP_URL: envVar.url() },
  config: (env) => ({ server: { origin: env.APP_URL } }),
});
`;

  /** Run `body` with `vars` set in the process environment, then restore it. */
  async function withProcessEnv<T>(
    vars: Readonly<Record<string, string>>,
    body: () => Promise<T>,
  ): Promise<T> {
    const saved = new Map(Object.keys(vars).map((key) => [key, process.env[key]] as const));
    Object.assign(process.env, vars);
    try {
      return await body();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it('resolves it for cwd as the bin does: the .env file and the real variables', async () => {
    const dir = project({
      'jsails.config.ts': declared,
      '.env': 'APP_URL=https://from-dotenv.test\n',
    });
    const fromFile = await loadApp({ configPath: 'jsails.config.ts', cwd: dir });
    assert.equal(fromFile.config.server.origin, 'https://from-dotenv.test');
    const fromProcess = await withProcessEnv({ APP_URL: 'https://from-process.test' }, () =>
      loadApp({ configPath: 'jsails.config.ts', cwd: dir }),
    );
    assert.equal(fromProcess.config.server.origin, 'https://from-process.test');
  });

  it('applies the listen overrides a test runner sets', async () => {
    const dir = project({
      'jsails.app.js': 'export default { port: 3000 };\n',
    });
    const app = await withProcessEnv(
      { JSAILS_PORT: '4999', JSAILS_TRUSTED_PROXIES: 'hops=1' },
      () => loadApp({ cwd: dir }),
    );
    assert.equal(app.config.port, 4999);
    assert.deepEqual(app.config.server.trustedProxies, { hops: 1 });
  });

  it("checks a parent JSails process's marker, as a child of the bin does", async () => {
    const dir = project({ 'jsails.config.ts': declared });
    const foreign = project({});
    const marker = resolveEnvironment({ rootDir: foreign, secrets: 'required' }).marker;
    await withProcessEnv({ JSAILS_ENV_RESOLVED: marker, APP_URL: 'https://x.test' }, () =>
      assert.rejects(loadApp({ configPath: 'jsails.config.ts', cwd: dir }), (error: unknown) =>
        EnvironmentErrors.is(error, 'inherited_foreign_project'),
      ),
    );
    const own = resolveEnvironment({ rootDir: dir, secrets: 'required' }).marker;
    const app = await withProcessEnv({ JSAILS_ENV_RESOLVED: own, APP_URL: 'https://x.test' }, () =>
      loadApp({ configPath: 'jsails.config.ts', cwd: dir }),
    );
    assert.equal(app.config.server.origin, 'https://x.test');
  });
});

describe('loadApp: the activation literal', () => {
  const managed = `${HEAD}export default defineApp({
  config: () => ({ plugins: { activation: { mode: 'managed' } } }),
});
`;

  it('seals the literal mode the config states', async () => {
    const app = await load(project({ 'jsails.config.ts': managed }));
    assert.equal(activationModeOf(app), 'managed');
    assert.equal('activation' in app.config.plugins, false);
  });

  it('refuses a mode the environment or a variable could choose', async () => {
    const cases: readonly [string, string][] = [
      [
        `${HEAD}export default defineApp({
  config: (env) => ({ plugins: { activation: { mode: env.MODE } } }),
});
`,
        'env.MODE',
      ],
      [
        `${HEAD}const mode = 'managed' as const;
export default defineApp({ config: () => ({ plugins: { activation: { mode } } }) });
`,
        'mode } }',
      ],
      [
        `${HEAD}const activation = { mode: 'managed' } as const;
export default defineApp({ config: () => ({ plugins: { activation } }) });
`,
        'activation } }',
      ],
      [
        `${HEAD}export default defineApp({
  config: () => ({ plugins: { activation: Math.random() > 1 ? { mode: 'managed' } : { mode: 'locked' } } }),
});
`,
        'Math.random',
      ],
    ];
    for (const [source, marker] of cases) {
      const [line, column] = positionOf(source, marker);
      await rejectsAt(
        load(project({ 'jsails.config.ts': source })),
        'activation_not_literal',
        'jsails.config.ts',
        line,
        column,
      );
    }
  });

  it('refuses a result that disagrees with its literal, at the literal', async () => {
    const source = `${HEAD}const managed = { plugins: { activation: { mode: 'managed' } } } as const;
export default defineApp({
  env: {},
  config: () => (process.argv.length < 0 ? managed : {}),
});
`;
    const [line, column] = positionOf(source, "activation: { mode: 'managed' }");
    await assert.rejects(load(project({ 'jsails.config.ts': source })), (error: unknown) => {
      assert.ok(ConfigErrors.is(error, 'activation_mismatch'), String(error));
      assert.deepEqual(error.context, { path: 'jsails.config.ts', line, column });
      return true;
    });
  });

  it('refuses a managed result that no plugins.activation literal states', async () => {
    const source = `${HEAD}const plugins = { activation: { mode: 'managed' } } as const;
export default defineApp({ config: () => ({ plugins }) });
`;
    await assert.rejects(load(project({ 'jsails.config.ts': source })), (error: unknown) => {
      assert.ok(ConfigErrors.is(error, 'activation_unstated'), String(error));
      assert.deepEqual(error.context, { path: 'jsails.config.ts' });
      return true;
    });
  });

  it('reads only plugins.activation: an activation key elsewhere is not the mode', async () => {
    const legacy = project({
      'jsails.app.js': `const options = { activation: true, nested: { activation: { mode: 'email' } } };
export default { port: options.activation ? 0 : 1, plugins: { use: [] } };
`,
    });
    const app = await loadApp({ cwd: legacy, env: {} });
    assert.equal(app.config.port, 0);
    assert.equal(activationModeOf(app), 'locked');
    const typed = project({
      'jsails.config.ts': `${HEAD}import { settings } from './config/settings.ts';
export default defineApp({
  config: () => ({ port: settings.activation.mode === 'locked' ? 0 : 1, plugins: { activation: { mode: 'managed' } } }),
});
`,
      'config/settings.ts': `export const settings = { activation: { mode: 'locked' } } as const;\n`,
    });
    assert.equal(activationModeOf(await load(typed)), 'managed');
  });

  it('refuses a second plugins.activation in the graph, at the second', async () => {
    const dir = project({
      'jsails.config.ts': `${HEAD}import { base } from './config/base.ts';
export default defineApp({
  config: () => ({ port: base.port, plugins: { activation: { mode: 'managed' } } }),
});
`,
      'config/base.ts': `export const base = { port: 1, plugins: { activation: { mode: 'locked' } } } as const;\n`,
    });
    const [line, column] = positionOf(
      `export const base = { port: 1, plugins: { activation: { mode: 'locked' } } } as const;\n`,
      'activation',
    );
    await rejectsAt(load(dir), 'activation_repeated', 'config/base.ts', line, column);
  });

  it('ignores managed-looking environment variables', async () => {
    const dir = project({
      'jsails.config.ts': `${HEAD}export default defineApp({ config: () => ({}) });\n`,
    });
    const app = await load(dir, {
      JSAILS_PLUGINS_MODE: 'managed',
      JSAILS_ACTIVATION: 'managed',
      JSAILS_PLUGINS_ACTIVATION: 'managed',
      JSAILS_PLUGINS_MANAGED: '1',
    });
    assert.equal(activationModeOf(app), 'locked');
  });
});

describe('loadApp: the legacy jsails.app.js root', () => {
  it('loads a plain config object and reads its activation literal', async () => {
    const dir = project({
      'jsails.app.js': `export default { port: 0, plugins: { activation: { mode: 'managed' } } };\n`,
    });
    const app = await loadApp({ cwd: dir, env: {} });
    assert.equal(app.config.port, 0);
    assert.equal(activationModeOf(app), 'managed');
  });

  it('refuses a legacy root whose mode is computed', async () => {
    const dir = project({
      'jsails.app.js': `const mode = process.argv.length > 0 ? 'managed' : 'locked';
export default { plugins: { activation: { mode } } };
`,
    });
    await rejectsAt(
      loadApp({ cwd: dir, env: {} }),
      'activation_not_literal',
      'jsails.app.js',
      2,
      43,
    );
  });

  it('does not restrict a legacy root to the config graph', async () => {
    const dir = project({
      'jsails.app.js': `import { readFileSync } from 'node:fs';\nexport default { port: typeof readFileSync === 'function' ? 0 : 1 };\n`,
    });
    assert.equal((await loadApp({ cwd: dir, env: {} })).config.port, 0);
  });

  it('reports a missing root without filesystem details', async () => {
    const dir = project({});
    await assert.rejects(loadApp({ cwd: dir, env: {} }), (error: unknown) => {
      assert.ok(error instanceof AppConfigError);
      assert.equal(error.code, 'load_failed');
      assert.match(error.message, /failed to load app config "jsails\.app\.js"/);
      return true;
    });
  });
});

describe('createLoadedApp and defineApp', () => {
  it('seals the mode a config built in code states, locked by default', () => {
    assert.equal(activationModeOf(createLoadedApp({})), 'locked');
    assert.equal(
      activationModeOf(createLoadedApp({ plugins: { activation: { mode: 'managed' } } })),
      'managed',
    );
  });

  it('refuses a promise or a class instance as a config, leaving no unhandled rejection', () => {
    const values: readonly unknown[] = [
      Promise.resolve({ port: 1234 }),
      Promise.reject(new Error('supersecret-password')),
      new Map([['port', 1234]]),
      new Date(0),
    ];
    for (const value of values) {
      assert.throws(
        () => createLoadedApp(value as never),
        (error: unknown) =>
          error instanceof AppConfigError && !/supersecret|1234/.test(error.message),
      );
    }
  });

  it('brands definitions, so a look-alike object is not one', () => {
    const definition = defineApp({ config: () => ({ port: 1 }) });
    assert.equal(isAppDefinition(definition), true);
    assert.equal(isAppDefinition({ env: undefined, config: () => ({}) }), false);
    assert.equal(Object.isFrozen(definition), true);
  });

  it('types the config function: unknown keys and undeclared variables do not compile', () => {
    // @ts-expect-error an unknown top-level key is a compile error
    defineApp({ config: () => ({ port: 1, nope: 1 }) });
    // @ts-expect-error a variable the env does not declare is a compile error
    defineApp({ env: { P: envVar.integer() }, config: (env) => ({ port: env.Q }) });
    // @ts-expect-error the activation mode is one of two literals
    defineApp({ config: () => ({ plugins: { activation: { mode: 'open' } } }) });
    const typed = defineApp({
      env: { P: envVar.integer() },
      config: (env) => ({ port: env.P, extensions: [] }),
    });
    assert.equal(isAppDefinition(typed), true);
  });
});
