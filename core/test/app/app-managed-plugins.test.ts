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
import { validateAppConfig } from '../../src/app/config/index.js';
import type { ServiceToken } from '../../src/extensions/index.js';
import {
  PLUGIN_STATE_VERSION,
  type PluginState,
  type PluginStateSource,
} from '../../src/plugins/state-store.js';

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
    },
    loads: () => loads,
  };
}

interface ManagedFixture {
  readonly pluginsDir: string;
  readonly token: ServiceToken<{ value: string }>;
}

/**
 * Write a bundle plugin under `<dir>/storage/plugins/<id>` whose setup provides
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
    join(pluginsDir, id, 'manifest.json'),
    `${JSON.stringify(
      { id, version: '1.0.0', jsailsCompat: '^0.1.0', entry: './index.mjs' },
      null,
      2,
    )}\n`,
  );
  writeFile(
    join(pluginsDir, id, 'index.mjs'),
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
