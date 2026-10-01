/**
 * Managed plugin activation at application boot.
 *
 * These cases pin the three-way switch in `createApplication`: managed state is
 * consulted only when `plugins.managed` is true, a state source is present, and
 * the deployment shape is not `static`. Fixtures are real ESM modules written to
 * a temp directory, matching the pattern in `app-application.test.ts`.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import { createApplication } from '../../src/app/application.js';
import { AppConfigError, validateAppConfig } from '../../src/app/config/index.js';
import type { ServiceToken } from '../../src/extensions/index.js';
import {
  PLUGIN_STATE_VERSION,
  PluginStateError,
  type PluginState,
  type PluginStateSource,
} from '../../src/plugins/state-store.js';
import { bundleManifestJson } from '../plugins/manifest-fixture.js';

const root = mkdtempSync(join(tmpdir(), 'jsails-managed-plugins-'));
after(() => {
  rmSync(root, { recursive: true, force: true });
});

let sequence = 0;

/** Write a file (creating parent directories) and return its absolute path. */
function writeFile(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** Create an isolated case directory. */
function setupCase(): string {
  return mkdtempSync(join(root, `case-${sequence++}-`));
}

function makeConfig(dir: string, overrides: Record<string, unknown> = {}) {
  return validateAppConfig({ rootDir: dir, port: 0, ...overrides }, { cwd: dir });
}

/** A state source that records how many times `load` was called. */
function fakeStateSource(state: PluginState): {
  readonly source: PluginStateSource;
  readonly loads: () => number;
} {
  let loads = 0;
  return {
    source: {
      load() {
        loads += 1;
        return state;
      },
      save() {},
      putEntry() {},
      removeEntry() {},
    },
    loads: () => loads,
  };
}

interface ManagedFixture {
  readonly pluginsDir: string;
  readonly token: ServiceToken<{ value: string }>;
}

/**
 * Write a bundle plugin under `<dir>/storage/plugins/<id>/1.0.0` whose setup provides
 * a service through a shared token module, so the test can observe activation.
 */
async function managedPluginFixture(dir: string, id: string): Promise<ManagedFixture> {
  const tokenFile = writeFile(
    join(dir, 'managed-token.mjs'),
    'export const TOKEN = { name: "managed" };\n',
  );
  const tokenUrl = pathToFileURL(tokenFile).href;
  const pluginsDir = join(dir, 'storage', 'plugins');

  writeFile(
    join(pluginsDir, id, '1.0.0', 'manifest.json'),
    `${JSON.stringify(
      bundleManifestJson({ id, version: '1.0.0', jsailsCompat: '^0.1.0', entry: './index.mjs' }),
      null,
      2,
    )}\n`,
  );
  writeFile(
    join(pluginsDir, id, '1.0.0', 'index.mjs'),
    `import { TOKEN } from ${JSON.stringify(tokenUrl)};
export default {
  name: ${JSON.stringify(id)},
  setup(context) {
    context.services.provide(TOKEN, { value: 'from-managed' });
  },
};
`,
  );

  const tokenModule = (await import(tokenUrl)) as {
    TOKEN: ServiceToken<{ value: string }>;
  };
  return { pluginsDir, token: tokenModule.TOKEN };
}

describe('createApplication: managed plugin activation', () => {
  it('activates a code-enabled plugin through the state source when managed is true', async () => {
    const dir = setupCase();
    const fixture = await managedPluginFixture(dir, 'acme');
    const state = fakeStateSource({ version: PLUGIN_STATE_VERSION, plugins: {} });

    const config = makeConfig(dir, {
      plugins: {
        managed: true,
        stateSource: state.source,
        pluginsDir: fixture.pluginsDir,
        enabled: ['acme'],
      },
    });

    const app = await createApplication(config);

    assert.equal(state.loads(), 1, 'the managed state source is read exactly once');
    assert.equal(app.services.get(fixture.token).value, 'from-managed');

    await app.close();
  });

  it('does not read state or activate plugins when managed is true without a state source', async () => {
    const dir = setupCase();
    const fixture = await managedPluginFixture(dir, 'acme');

    const config = makeConfig(dir, {
      plugins: {
        managed: true,
        pluginsDir: fixture.pluginsDir,
        enabled: ['acme'],
      },
    });

    const app = await createApplication(config);

    assert.equal(app.services.tryGet(fixture.token), undefined);

    await app.close();
  });

  it('does not read state or activate plugins for the static shape', async () => {
    const dir = setupCase();
    const fixture = await managedPluginFixture(dir, 'acme');
    const state = fakeStateSource({ version: PLUGIN_STATE_VERSION, plugins: {} });

    const config = makeConfig(dir, {
      shape: 'static',
      plugins: {
        managed: true,
        stateSource: state.source,
        pluginsDir: fixture.pluginsDir,
        enabled: ['acme'],
      },
    });

    const app = await createApplication(config);

    assert.equal(state.loads(), 0, 'static export never consults managed state');
    assert.equal(app.services.tryGet(fixture.token), undefined);

    await app.close();
  });
});

describe('createApplication: managed plugin load failures', () => {
  function brokenBundle(dir: string, id: string): string {
    const pluginsDir = join(dir, 'storage', 'plugins');
    writeFile(
      join(pluginsDir, id, '1.0.0', 'manifest.json'),
      JSON.stringify(
        bundleManifestJson({ id, version: '1.0.0', jsailsCompat: '^0.1.0', entry: './index.mjs' }),
      ),
    );
    writeFile(join(pluginsDir, id, '1.0.0', 'index.mjs'), 'throw new Error("secret-token-123");\n');
    return pluginsDir;
  }

  it('fails boot when an enabled managed plugin does not load, value-free', async () => {
    const dir = setupCase();
    brokenBundle(dir, 'audit');
    const state = fakeStateSource({
      version: PLUGIN_STATE_VERSION,
      plugins: { audit: { active: '1.0.0', enabled: true } },
    });
    const config = makeConfig(dir, { plugins: { managed: true, stateSource: state.source } });

    await assert.rejects(createApplication(config), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /managed plugin\(s\) failed to load: audit \(plugin_load_failed/);
      assert.equal(error.message.includes('secret-token-123'), false);
      return true;
    });
  });

  it('fails boot when an enabled managed plugin is not installed', async () => {
    const dir = setupCase();
    const state = fakeStateSource({
      version: PLUGIN_STATE_VERSION,
      plugins: { audit: { active: '1.0.0', enabled: true } },
    });
    const config = makeConfig(dir, { plugins: { managed: true, stateSource: state.source } });

    await assert.rejects(
      createApplication(config),
      /audit \((enabled_plugin_missing|active_version_missing)/,
    );
  });

  it('boots when only plugins that would not load have version problems', async () => {
    const dir = setupCase();
    const pluginsDir = join(dir, 'storage', 'plugins');
    // `off` is disabled and its recorded active version is not on disk;
    // `spare` is not in state at all (so not enabled) yet has two versions.
    // Neither would load, so neither may fail boot. Both modules throw if
    // they are ever imported.
    for (const [id, version] of [
      ['off', '1.0.0'],
      ['spare', '1.0.0'],
      ['spare', '2.0.0'],
    ] as const) {
      writeFile(
        join(pluginsDir, id, version, 'manifest.json'),
        JSON.stringify(
          bundleManifestJson({ id, version, jsailsCompat: '^0.1.0', entry: './index.mjs' }),
        ),
      );
      writeFile(join(pluginsDir, id, version, 'index.mjs'), 'throw new Error("imported");\n');
    }
    const state = fakeStateSource({
      version: PLUGIN_STATE_VERSION,
      plugins: { off: { active: '2.0.0', enabled: false } },
    });
    const config = makeConfig(dir, { plugins: { managed: true, stateSource: state.source } });

    const app = await createApplication(config);
    await app.close();
  });

  it('boots with a warning when allowLoadFailures is set', async () => {
    const dir = setupCase();
    brokenBundle(dir, 'audit');
    const state = fakeStateSource({
      version: PLUGIN_STATE_VERSION,
      plugins: { audit: { active: '1.0.0', enabled: true } },
    });
    const config = makeConfig(dir, {
      plugins: { managed: true, stateSource: state.source, allowLoadFailures: true },
    });

    const warnings: string[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(warning.message);
    };
    process.on('warning', onWarning);
    try {
      const app = await createApplication(config);
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(warnings.some((message) => message.includes('audit (plugin_load_failed')));
      await app.close();
    } finally {
      process.off('warning', onWarning);
    }
  });

  it('keeps a value-free activation error as the boot error cause', async () => {
    const dir = setupCase();
    const failing: PluginStateSource = {
      load() {
        throw new PluginStateError('unparseable', 'plugin state is not valid JSON');
      },
      save() {},
      putEntry() {},
      removeEntry() {},
    };
    const config = makeConfig(dir, { plugins: { managed: true, stateSource: failing } });

    await assert.rejects(createApplication(config), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /managed plugins could not be activated/);
      assert.ok(error.cause instanceof PluginStateError);
      return true;
    });
  });

  it('activates from the plugins folder under config.storage by default', async () => {
    const dir = setupCase();
    const fixture = await managedPluginFixture(dir, 'acme');
    const state = fakeStateSource({
      version: PLUGIN_STATE_VERSION,
      plugins: { acme: { active: '1.0.0', enabled: true } },
    });
    // `storage` is the default directory; the plugins folder is derived from it
    // rather than from the working directory.
    const config = makeConfig(dir, { plugins: { managed: true, stateSource: state.source } });
    assert.equal(config.pluginsDir, fixture.pluginsDir);

    const app = await createApplication(config);
    assert.equal(app.services.get(fixture.token).value, 'from-managed');
    await app.close();
  });
});

describe('validateAppConfig: plugins.stateSource', () => {
  it('refuses a source without the per-entry writes at config load', () => {
    const dir = setupCase();
    const complete = fakeStateSource({ version: PLUGIN_STATE_VERSION, plugins: {} }).source;
    for (const missing of ['putEntry', 'removeEntry', 'save', 'load'] as const) {
      const source: Partial<PluginStateSource> = { ...complete };
      delete source[missing];
      assert.throws(
        () => makeConfig(dir, { plugins: { managed: true, stateSource: source } }),
        (error: unknown) =>
          error instanceof AppConfigError &&
          /config\.plugins\.stateSource must be a plugin state source/.test(error.message),
        missing,
      );
    }
    assert.equal(
      makeConfig(dir, { plugins: { managed: true, stateSource: complete } }).plugins?.stateSource,
      complete,
    );
  });
});
