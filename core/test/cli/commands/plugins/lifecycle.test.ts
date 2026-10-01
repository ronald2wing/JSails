/**
 * Headless plugin lifecycle CLI tests: `plugins install|uninstall|enable|
 * disable|rollback`.
 *
 * These drive `runPluginsCommand` directly with injected dependencies — no
 * network, database, or filesystem mutation beyond temp fixture dirs. They
 * assert the argument gating, the value-free failure discipline, the installer
 * wiring (including the checksum key derived from the URL path basename), the
 * code-enabled conflict refusal, and the managed-state mutate/init/destroy
 * ordering. Secrets are never echoed: a non-value-free error falls back to a
 * fixed message.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { DataSource } from 'typeorm';

import { runPluginsCommand, type PluginsDeps } from '../../../../src/cli/commands/plugins/index.js';
import { DatabasePluginState } from '../../../../src/plugins/database-state-entity.js';
import { createDatabasePluginStateStore } from '../../../../src/plugins/database-state-store.js';
import {
  PluginInstallerError,
  type InstallPluginInput,
  type PluginInstaller,
  type PluginInstallerOptions,
} from '../../../../src/plugins/installer.js';
import {
  PluginStateError,
  PLUGIN_STATE_VERSION,
  type PluginState,
  type PluginStateEntry,
  type PluginStateSource,
} from '../../../../src/plugins/state-store.js';
import { createEmptyDataSource } from '../../../../src/testing/index.js';
import { bundleManifestJson } from '../../../plugins/manifest-fixture.js';

interface Sinks {
  out: string[];
  err: string[];
}

function sinks(): Sinks {
  return { out: [], err: [] };
}

const fixturesRoot = mkdtempSync(join(tmpdir(), 'plugins-cli-'));

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

/** An in-memory installer that records every call plus the directory it was built for. */
function makeInstaller() {
  const installs: InstallPluginInput[] = [];
  const uninstalls: Array<{ id: string; force: boolean }> = [];
  const pluginsDirs: string[] = [];
  const installer: PluginInstaller = {
    install: async (input) => {
      installs.push(input);
      return { id: input.id, version: input.version, warnings: [] };
    },
    uninstall: async (id, options) => {
      uninstalls.push({ id, force: options?.force === true });
    },
    rollback: async () => {},
  };
  return {
    installs,
    uninstalls,
    pluginsDirs,
    installer,
    createInstaller: (options: PluginInstallerOptions): PluginInstaller => {
      pluginsDirs.push(options.pluginsDir);
      return installer;
    },
  };
}

/**
 * An in-memory state source with the {@link PluginStateSource} write contract
 * (no write drops an id it was not asked to remove) that records every write.
 */
function makeStateSource(initial: PluginState['plugins'] = {}) {
  let state: PluginState = { version: PLUGIN_STATE_VERSION, plugins: initial };
  const writes: string[] = [];
  const source: PluginStateSource = {
    async load() {
      return state;
    },
    async save(next: PluginState) {
      writes.push('save');
      state = { version: state.version, plugins: { ...state.plugins, ...next.plugins } };
    },
    async putEntry(id: string, entry: PluginStateEntry) {
      writes.push(`put:${id}`);
      state = { version: state.version, plugins: { ...state.plugins, [id]: entry } };
    },
    async removeEntry(id: string) {
      writes.push(`remove:${id}`);
      const plugins = { ...state.plugins };
      delete plugins[id];
      state = { version: state.version, plugins };
    },
  };
  return {
    source,
    writes,
    createStateStore: (): PluginStateSource => source,
    get state() {
      return state;
    },
  };
}

/** A fake TypeORM data source recording init/destroy order. */
function makeDataSource() {
  const calls: string[] = [];
  const dataSource = {
    async initialize() {
      calls.push('initialize');
    },
    async destroy() {
      calls.push('destroy');
    },
  } as unknown as DataSource;
  return { calls, dataSource };
}

/**
 * A real database state store on an in-memory sqljs database, plus a data
 * source handle for the CLI whose initialize/destroy leave the shared database
 * open, so a test can read the rows after the command closed "its" source.
 */
async function openSharedStateDatabase() {
  const dataSource = await createEmptyDataSource([DatabasePluginState]);
  const handle = {
    async initialize() {},
    async destroy() {},
  } as unknown as DataSource;
  return {
    dataSource,
    handle,
    store: () => createDatabasePluginStateStore({ dataSource }),
    close: () => dataSource.destroy(),
  };
}

/** Build a deps value with the lifecycle seams wired and a fixed cwd. */
function lifecycleDeps(
  s: Sinks,
  overrides: {
    loadAppPlugins?: PluginsDeps['loadAppPlugins'];
    loadDataSource?: PluginsDeps['loadDataSource'];
    createInstaller?: PluginsDeps['createInstaller'];
    createStateStore?: PluginsDeps['createStateStore'];
  } = {},
): PluginsDeps {
  return {
    cwd: join(fixturesRoot, 'cwd'),
    frameworkVersion: '0.1.0',
    stdout: (text) => s.out.push(text),
    stderr: (text) => s.err.push(text),
    ...overrides,
  };
}

/** Write an installed bundle manifest; `summary` tells the fixtures apart. */
function writeBundle(pluginsDir: string, summary: string): void {
  const bundleDir = join(pluginsDir, 'acme', '1.2.3');
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(
    join(bundleDir, 'manifest.json'),
    JSON.stringify(
      bundleManifestJson({
        id: 'acme',
        version: '1.2.3',
        summary,
        jsailsCompat: '^0.1.0',
        entry: './index.js',
      }),
    ),
  );
}

const INSTALL_ARGS = [
  'install',
  'acme',
  '--version',
  '1.2.3',
  '--url',
  'https://example.com/acme.tgz',
  '--sha256',
  'deadbeef',
];

describe('plugins lifecycle argument gating', () => {
  it('requires --url for install (exit 2)', async () => {
    const s = sinks();
    const code = await runPluginsCommand(
      ['install', 'acme', '--version', '1.2.3'],
      lifecycleDeps(s),
    );
    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /requires --url/);
  });

  it('requires --version for install (exit 2)', async () => {
    const s = sinks();
    const code = await runPluginsCommand(
      ['install', 'acme', '--url', 'https://example.com/acme.tgz'],
      lifecycleDeps(s),
    );
    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /requires --version/);
  });

  it('requires <id> <version> for rollback (exit 2)', async () => {
    const s = sinks();
    const code = await runPluginsCommand(['rollback', 'acme'], lifecycleDeps(s));
    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /requires <id> <version>/);
  });

  it('rejects an extra rollback positional (exit 2)', async () => {
    const s = sinks();
    const code = await runPluginsCommand(['rollback', 'acme', '1.0.0', 'extra'], lifecycleDeps(s));
    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /requires <id> <version>/);
  });

  it('rejects an unknown flag for a lifecycle subcommand (exit 2)', async () => {
    const s = sinks();
    const code = await runPluginsCommand([...INSTALL_ARGS, '--json'], lifecycleDeps(s));
    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /--json is not valid for "plugins install"/);
  });

  it('rejects --force on a subcommand that does not support it (exit 2)', async () => {
    const s = sinks();
    const code = await runPluginsCommand(['enable', 'acme', '--force'], lifecycleDeps(s));
    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /--force is not valid for "plugins enable"/);
  });

  it('rejects an invalid plugin id (exit 1)', async () => {
    const s = sinks();
    const code = await runPluginsCommand(
      ['install', 'BAD ID', '--version', '1.0.0', '--url', 'https://example.com/a.tgz'],
      lifecycleDeps(s),
    );
    assert.equal(code, 1);
    assert.match(s.err.join('\n'), /plugin id is invalid/);
  });

  it('rejects an invalid rollback version (exit 1)', async () => {
    const s = sinks();
    const code = await runPluginsCommand(['rollback', 'acme', 'not-a-version'], lifecycleDeps(s));
    assert.equal(code, 1);
    assert.match(s.err.join('\n'), /plugin version is invalid/);
  });

  it('rejects an install with extra positionals (exit 2)', async () => {
    const s = sinks();
    const code = await runPluginsCommand([...INSTALL_ARGS, 'extra'], lifecycleDeps(s));
    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /requires <id>/);
  });
});

describe('plugins install', () => {
  it('installs through the installer with id/version/url and a checksum keyed by artifact name', async () => {
    const inst = makeInstaller();
    const s = sinks();
    const code = await runPluginsCommand(
      [
        'install',
        'acme',
        '--version',
        '1.2.3',
        '--url',
        'https://example.com/dl/acme-1.2.3.tgz?token=secret#frag',
        '--sha256',
        'deadbeef',
      ],
      lifecycleDeps(s, {
        loadAppPlugins: async () => undefined,
        createInstaller: inst.createInstaller,
      }),
    );
    assert.equal(code, 0);
    assert.match(s.out.join('\n'), /Installed acme@1\.2\.3\./);

    assert.equal(inst.installs.length, 1);
    const call = inst.installs[0]!;
    assert.equal(call.id, 'acme');
    assert.equal(call.version, '1.2.3');
    assert.equal(call.url, 'https://example.com/dl/acme-1.2.3.tgz?token=secret#frag');
    assert.deepEqual(call.checksums, { 'acme-1.2.3.tgz': 'deadbeef' });
    assert.equal(call.signature, undefined);
    assert.equal(call.allowUnverified, false);
  });

  it('refuses an install without --sha256 before any download (exit 2)', async () => {
    const inst = makeInstaller();
    const s = sinks();
    const code = await runPluginsCommand(
      ['install', 'acme', '--version', '1.2.3', '--url', 'https://example.com/acme.tgz'],
      lifecycleDeps(s, {
        loadAppPlugins: async () => undefined,
        createInstaller: inst.createInstaller,
      }),
    );
    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /requires --sha256/);
    assert.equal(inst.installs.length, 0);
  });

  it('refuses a --signature it cannot verify instead of ignoring it (exit 2)', async () => {
    const inst = makeInstaller();
    const s = sinks();
    const code = await runPluginsCommand(
      [...INSTALL_ARGS, '--signature', 'c2ln'],
      lifecycleDeps(s, {
        loadAppPlugins: async () => undefined,
        createInstaller: inst.createInstaller,
      }),
    );
    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /cannot verify --signature/);
    assert.equal(inst.installs.length, 0);
  });

  it('installs unverified only with --allow-unverified, and warns', async () => {
    const inst = makeInstaller();
    const s = sinks();
    const code = await runPluginsCommand(
      [
        'install',
        'acme',
        '--version',
        '1.2.3',
        '--url',
        'https://example.com/acme.tgz',
        '--allow-unverified',
      ],
      lifecycleDeps(s, {
        loadAppPlugins: async () => undefined,
        createInstaller: inst.createInstaller,
      }),
    );
    assert.equal(code, 0);
    assert.equal(inst.installs[0]?.allowUnverified, true);
    assert.equal(inst.installs[0]?.checksums, undefined);
    assert.match(
      s.err.join('\n'),
      /warning: installing a plugin bundle without an integrity check/,
    );
  });

  it('refuses an unverified plain-http download from a non-loopback host (exit 2)', async () => {
    const inst = makeInstaller();
    const s = sinks();
    const base = ['install', 'acme', '--version', '1.2.3', '--allow-unverified', '--url'];
    const deps = lifecycleDeps(s, {
      loadAppPlugins: async () => undefined,
      createInstaller: inst.createInstaller,
    });
    assert.equal(await runPluginsCommand([...base, 'http://cdn.example/acme.tgz'], deps), 2);
    assert.equal(inst.installs.length, 0);
    assert.equal(await runPluginsCommand([...base, 'http://127.0.0.1:8080/acme.tgz'], deps), 0);
    assert.equal(inst.installs.length, 1);
  });

  it('refuses a checksummed plain-http download from a non-loopback host (exit 2)', async () => {
    const inst = makeInstaller();
    const s = sinks();
    const base = ['install', 'acme', '--version', '1.2.3', '--sha256', 'ab'.repeat(32), '--url'];
    const deps = lifecycleDeps(s, {
      loadAppPlugins: async () => undefined,
      createInstaller: inst.createInstaller,
    });
    assert.equal(await runPluginsCommand([...base, 'http://cdn.example/acme.tgz'], deps), 2);
    assert.match(s.err.join('\n'), /only downloads over https:/);
    assert.equal(inst.installs.length, 0);
    assert.equal(await runPluginsCommand([...base, 'http://localhost:8080/acme.tgz'], deps), 0);
    assert.equal(inst.installs.length, 1);
  });

  it('rejects --sha256 together with --allow-unverified (exit 2)', async () => {
    const s = sinks();
    const code = await runPluginsCommand(
      [...INSTALL_ARGS, '--allow-unverified'],
      lifecycleDeps(s, { loadAppPlugins: async () => undefined }),
    );
    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /mutually exclusive/);
  });

  it('wires the managed install to the database state source', async () => {
    const inst = makeInstaller();
    const state = makeStateSource();
    const db = makeDataSource();
    let captured: PluginInstallerOptions | undefined;
    const s = sinks();

    const code = await runPluginsCommand(
      [...INSTALL_ARGS, '--db-config', 'jsails.database.js'],
      lifecycleDeps(s, {
        loadAppPlugins: async () => ({ enabled: [], managed: true }),
        loadDataSource: async () => db.dataSource,
        createStateStore: () => state.source,
        createInstaller: (options) => {
          captured = options;
          return inst.installer;
        },
      }),
    );

    assert.equal(code, 0);
    assert.strictEqual(captured?.stateStore, state.source);
    assert.equal(captured?.allowPrivateHosts, true);
    assert.deepEqual(db.calls, ['initialize', 'destroy']);
  });

  it('resolves the default plugins dir under cwd and reports warnings to stderr', async () => {
    const pluginsDirs: string[] = [];
    const s = sinks();
    const code = await runPluginsCommand(
      INSTALL_ARGS,
      lifecycleDeps(s, {
        loadAppPlugins: async () => undefined,
        createInstaller: (options) => {
          pluginsDirs.push(options.pluginsDir);
          return {
            install: async (input) => ({
              id: input.id,
              version: input.version,
              warnings: ['be careful'],
            }),
            uninstall: async () => {},
            rollback: async () => {},
          };
        },
      }),
    );
    assert.equal(code, 0);
    assert.deepEqual(pluginsDirs, [join(fixturesRoot, 'cwd', 'storage', 'plugins')]);
    assert.match(s.err.join('\n'), /warning: be careful/);
  });

  it('installs into the app config pluginsDir, with --dir as an override', async () => {
    const pluginsDirs: string[] = [];
    const configured = join(fixturesRoot, 'app-root', 'var', 'plugins');
    const s = sinks();
    const deps = lifecycleDeps(s, {
      loadAppPlugins: async () => ({ pluginsDir: configured }),
      createInstaller: (options) => {
        pluginsDirs.push(options.pluginsDir);
        return {
          install: async (input) => ({ id: input.id, version: input.version, warnings: [] }),
          uninstall: async () => {},
          rollback: async () => {},
        };
      },
    });

    assert.equal(await runPluginsCommand(INSTALL_ARGS, deps), 0);
    assert.equal(await runPluginsCommand(['uninstall', 'acme'], deps), 0);
    assert.equal(await runPluginsCommand([...INSTALL_ARGS, '--dir', 'override'], deps), 0);
    assert.deepEqual(pluginsDirs, [configured, configured, join(fixturesRoot, 'cwd', 'override')]);
  });

  it('refuses a code-enabled id before calling the installer', async () => {
    const inst = makeInstaller();
    const s = sinks();
    const code = await runPluginsCommand(
      INSTALL_ARGS,
      lifecycleDeps(s, {
        loadAppPlugins: async () => ({ enabled: ['acme'] }),
        createInstaller: inst.createInstaller,
      }),
    );
    assert.equal(code, 1);
    assert.match(s.err.join('\n'), /code-enabled/);
    assert.equal(inst.installs.length, 0);
  });

  it('surfaces a value-free fallback when the installer throws a generic error', async () => {
    const s = sinks();
    const code = await runPluginsCommand(
      INSTALL_ARGS,
      lifecycleDeps(s, {
        loadAppPlugins: async () => undefined,
        createInstaller: () => ({
          install: async () => {
            throw new Error('db password hunter2 leaked');
          },
          uninstall: async () => {},
          rollback: async () => {},
        }),
      }),
    );
    assert.equal(code, 1);
    assert.match(s.err.join('\n'), /plugin install failed/);
    assert.doesNotMatch(s.err.join('\n'), /hunter2/);
  });

  it('echoes a value-free PluginInstallerError message', async () => {
    const s = sinks();
    const code = await runPluginsCommand(
      INSTALL_ARGS,
      lifecycleDeps(s, {
        loadAppPlugins: async () => undefined,
        createInstaller: () => ({
          install: async () => {
            throw new PluginInstallerError('checksum_mismatch', 'plugin checksum does not match');
          },
          uninstall: async () => {},
          rollback: async () => {},
        }),
      }),
    );
    assert.equal(code, 1);
    assert.match(s.err.join('\n'), /plugin checksum does not match/);
  });

  it('passes force: true to the installer when --force is set', async () => {
    const inst = makeInstaller();
    const s = sinks();
    const code = await runPluginsCommand(
      [...INSTALL_ARGS, '--force'],
      lifecycleDeps(s, {
        loadAppPlugins: async () => undefined,
        createInstaller: inst.createInstaller,
      }),
    );
    assert.equal(code, 0);
    assert.equal(inst.installs[0]?.force, true);
  });
});

describe('plugins uninstall', () => {
  it('wires managed uninstall to the database state source', async () => {
    const inst = makeInstaller();
    const state = makeStateSource();
    const db = makeDataSource();
    let captured: PluginInstallerOptions | undefined;
    const s = sinks();

    const code = await runPluginsCommand(
      ['uninstall', 'acme', '--db-config', 'jsails.database.js'],
      lifecycleDeps(s, {
        loadAppPlugins: async () => ({ enabled: [], managed: true }),
        loadDataSource: async () => db.dataSource,
        createStateStore: () => state.source,
        createInstaller: (options) => {
          captured = options;
          return inst.installer;
        },
      }),
    );

    assert.equal(code, 0);
    assert.strictEqual(captured?.stateStore, state.source);
    assert.equal(captured?.allowPrivateHosts, true);
    assert.deepEqual(db.calls, ['initialize', 'destroy']);
  });

  it('uninstalls through the installer', async () => {
    const inst = makeInstaller();
    const s = sinks();
    const code = await runPluginsCommand(
      ['uninstall', 'acme'],
      lifecycleDeps(s, { createInstaller: inst.createInstaller }),
    );
    assert.equal(code, 0);
    assert.match(s.out.join('\n'), /Uninstalled acme\./);
    assert.deepEqual(inst.uninstalls, [{ id: 'acme', force: false }]);
  });

  it('passes force: true to uninstall when --force is set', async () => {
    const inst = makeInstaller();
    const s = sinks();
    const code = await runPluginsCommand(
      ['uninstall', 'acme', '--force'],
      lifecycleDeps(s, { createInstaller: inst.createInstaller }),
    );
    assert.equal(code, 0);
    assert.deepEqual(inst.uninstalls, [{ id: 'acme', force: true }]);
  });
});

describe('plugins enable/disable', () => {
  it('flips enabled and initializes then destroys the data source', async () => {
    const stateSource = makeStateSource({ acme: { active: '1.2.3', enabled: false } });
    const db = makeDataSource();
    const s = sinks();

    const code = await runPluginsCommand(
      ['enable', 'acme'],
      lifecycleDeps(s, {
        loadAppPlugins: async () => ({ managed: true }),
        loadDataSource: async () => db.dataSource,
        createStateStore: stateSource.createStateStore,
      }),
    );

    assert.equal(code, 0);
    assert.deepEqual(stateSource.state.plugins['acme'], { active: '1.2.3', enabled: true });
    assert.deepEqual(db.calls, ['initialize', 'destroy']);
  });

  it('disables while preserving the active version', async () => {
    const stateSource = makeStateSource({ acme: { active: '1.2.3', enabled: true } });
    const db = makeDataSource();
    const s = sinks();

    const code = await runPluginsCommand(
      ['disable', 'acme'],
      lifecycleDeps(s, {
        loadAppPlugins: async () => ({ managed: true }),
        loadDataSource: async () => db.dataSource,
        createStateStore: stateSource.createStateStore,
      }),
    );

    assert.equal(code, 0);
    assert.deepEqual(stateSource.state.plugins['acme'], { active: '1.2.3', enabled: false });
  });

  it('keeps persisted settings when toggling', async () => {
    const settings = { apiKeyName: 'primary', retries: 3 };
    const stateSource = makeStateSource({ acme: { active: '1.2.3', enabled: true, settings } });
    const db = makeDataSource();
    const s = sinks();
    const deps = lifecycleDeps(s, {
      loadAppPlugins: async () => ({ managed: true }),
      loadDataSource: async () => db.dataSource,
      createStateStore: stateSource.createStateStore,
    });

    assert.equal(await runPluginsCommand(['disable', 'acme'], deps), 0);
    assert.deepEqual(stateSource.state.plugins['acme'], {
      active: '1.2.3',
      enabled: false,
      settings,
    });
    assert.equal(await runPluginsCommand(['enable', 'acme'], deps), 0);
    assert.deepEqual(stateSource.state.plugins['acme'], {
      active: '1.2.3',
      enabled: true,
      settings,
    });
  });

  it('writes only the toggled entry', async () => {
    const stateSource = makeStateSource({
      acme: { active: '1.2.3', enabled: false },
      other: { active: '2.0.0', enabled: true },
    });
    const s = sinks();

    const code = await runPluginsCommand(
      ['enable', 'acme'],
      lifecycleDeps(s, {
        loadAppPlugins: async () => ({ managed: true }),
        loadDataSource: async () => makeDataSource().dataSource,
        createStateStore: stateSource.createStateStore,
      }),
    );

    assert.equal(code, 0);
    assert.deepEqual(stateSource.writes, ['put:acme']);
  });

  it("keeps another store's change to a different plugin made after the CLI loaded", async () => {
    const shared = await openSharedStateDatabase();
    try {
      const appStore = shared.store();
      await appStore.putEntry('acme', { active: '1.0.0', enabled: false });
      await appStore.putEntry('other', { active: '2.0.0', enabled: true });
      const s = sinks();

      const code = await runPluginsCommand(
        ['enable', 'acme'],
        lifecycleDeps(s, {
          loadAppPlugins: async () => ({ managed: true }),
          loadDataSource: async () => shared.handle,
          createStateStore: () => {
            const cliStore = shared.store();
            return {
              ...cliStore,
              async load() {
                const snapshot = await cliStore.load();
                // The app disables "other" between the CLI's read and its write.
                await appStore.putEntry('other', { active: '2.0.0', enabled: false });
                return snapshot;
              },
            };
          },
        }),
      );

      assert.equal(code, 0, s.err.join('\n'));
      assert.deepEqual((await appStore.load()).plugins, {
        acme: { active: '1.0.0', enabled: true },
        other: { active: '2.0.0', enabled: false },
      });
    } finally {
      await shared.close();
    }
  });

  it('fails value-free when the deployment is not managed', async () => {
    const db = makeDataSource();
    const s = sinks();

    const code = await runPluginsCommand(
      ['enable', 'acme'],
      lifecycleDeps(s, {
        loadAppPlugins: async () => undefined,
        loadDataSource: async () => db.dataSource,
      }),
    );

    assert.equal(code, 1);
    assert.match(s.err.join('\n'), /not managed/);
    assert.deepEqual(db.calls, []);
  });

  it('fails when the id is not in the managed state', async () => {
    const stateSource = makeStateSource({});
    const db = makeDataSource();
    const s = sinks();

    const code = await runPluginsCommand(
      ['enable', 'ghost'],
      lifecycleDeps(s, {
        loadAppPlugins: async () => ({ managed: true }),
        loadDataSource: async () => db.dataSource,
        createStateStore: stateSource.createStateStore,
      }),
    );

    assert.equal(code, 1);
    assert.match(s.err.join('\n'), /plugin is not installed/);
    assert.deepEqual(db.calls, ['initialize', 'destroy']);
  });

  it('destroys the data source even when the state write fails', async () => {
    const db = makeDataSource();
    const s = sinks();
    const failWrite = async () => {
      throw new PluginStateError('io_failed', 'plugin state could not be updated');
    };

    const code = await runPluginsCommand(
      ['enable', 'acme'],
      lifecycleDeps(s, {
        loadAppPlugins: async () => ({ managed: true }),
        loadDataSource: async () => db.dataSource,
        createStateStore: () => ({
          load: async () => ({
            version: PLUGIN_STATE_VERSION,
            plugins: { acme: { active: '1.0.0', enabled: false } },
          }),
          save: failWrite,
          putEntry: failWrite,
          removeEntry: failWrite,
        }),
      }),
    );

    assert.equal(code, 1);
    assert.match(s.err.join('\n'), /plugin state could not be updated/);
    assert.deepEqual(db.calls, ['initialize', 'destroy']);
  });

  it('surfaces a value-free fallback when the database config fails to load', async () => {
    const s = sinks();
    const code = await runPluginsCommand(
      ['enable', 'acme'],
      lifecycleDeps(s, {
        loadAppPlugins: async () => ({ managed: true }),
        loadDataSource: async () => {
          throw new Error('credential secret leaked');
        },
      }),
    );
    assert.equal(code, 1);
    assert.match(s.err.join('\n'), /database config could not be loaded/);
    assert.doesNotMatch(s.err.join('\n'), /secret leaked/);
  });
});

describe('plugins rollback', () => {
  it('flips the active version while preserving enabled', async () => {
    const stateSource = makeStateSource({ acme: { active: '2.0.0', enabled: true } });
    const db = makeDataSource();
    const s = sinks();

    const code = await runPluginsCommand(
      ['rollback', 'acme', '1.0.0'],
      lifecycleDeps(s, {
        loadAppPlugins: async () => ({ managed: true }),
        loadDataSource: async () => db.dataSource,
        createStateStore: stateSource.createStateStore,
      }),
    );

    assert.equal(code, 0);
    assert.deepEqual(stateSource.state.plugins['acme'], { active: '1.0.0', enabled: true });
    assert.deepEqual(stateSource.writes, ['put:acme']);
    assert.deepEqual(db.calls, ['initialize', 'destroy']);
  });

  it('keeps persisted settings and a disabled flag across a rollback', async () => {
    const settings = { theme: 'dark' };
    const stateSource = makeStateSource({ acme: { active: '2.0.0', enabled: false, settings } });
    const db = makeDataSource();
    const s = sinks();

    const code = await runPluginsCommand(
      ['rollback', 'acme', '1.0.0'],
      lifecycleDeps(s, {
        loadAppPlugins: async () => ({ managed: true }),
        loadDataSource: async () => db.dataSource,
        createStateStore: stateSource.createStateStore,
      }),
    );

    assert.equal(code, 0);
    assert.deepEqual(stateSource.state.plugins['acme'], {
      active: '1.0.0',
      enabled: false,
      settings,
    });
  });
});

describe('plugins export', () => {
  it('emits the snapshot JSON to stdout and initializes then destroys the data source', async () => {
    const stateSource = makeStateSource({ acme: { active: '1.2.3', enabled: true } });
    const db = makeDataSource();
    const s = sinks();

    const code = await runPluginsCommand(
      ['export'],
      lifecycleDeps(s, {
        loadAppPlugins: async () => ({ managed: true }),
        loadDataSource: async () => db.dataSource,
        createStateStore: stateSource.createStateStore,
      }),
    );

    assert.equal(code, 0);
    const parsed = JSON.parse(s.out.join('\n')) as {
      format: string;
      version: number;
      plugins: Array<{ id: string; version: string; enabled: boolean; source: string }>;
    };
    assert.equal(parsed.format, 'jsails.plugins');
    assert.equal(parsed.version, 1);
    assert.deepEqual(parsed.plugins, [
      { id: 'acme', version: '1.2.3', enabled: true, source: 'bundle' },
    ]);
    assert.deepEqual(db.calls, ['initialize', 'destroy']);
  });

  it('refuses a --dir that escapes cwd before opening the database', async () => {
    let opened = false;
    const s = sinks();
    const code = await runPluginsCommand(
      ['export', '--dir', '../escape'],
      lifecycleDeps(s, {
        loadAppPlugins: async () => ({ managed: true }),
        loadDataSource: async () => {
          opened = true;
          return makeDataSource().dataSource;
        },
      }),
    );
    assert.equal(code, 1);
    assert.match(s.err.join('\n'), /escapes the working directory/);
    assert.equal(opened, false);
  });

  it('refuses when the deployment is not managed', async () => {
    const s = sinks();
    const code = await runPluginsCommand(
      ['export'],
      lifecycleDeps(s, { loadAppPlugins: async () => undefined }),
    );
    assert.equal(code, 1);
    assert.match(s.err.join('\n'), /not managed/);
  });

  it('rejects an unexpected flag (exit 2)', async () => {
    const s = sinks();
    const code = await runPluginsCommand(['export', '--json'], lifecycleDeps(s));
    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /--json is not valid for "plugins export"/);
  });
});

describe('plugins import', () => {
  it('reconciles managed state from a snapshot file', async () => {
    const stateSource = makeStateSource({});
    const db = makeDataSource();
    const s = sinks();
    const snapshotPath = join(fixturesRoot, 'cwd', 'snapshot.json');
    mkdirSync(join(fixturesRoot, 'cwd'), { recursive: true });
    writeFileSync(
      snapshotPath,
      `${JSON.stringify({
        format: 'jsails.plugins',
        version: 1,
        plugins: [{ id: 'acme', version: '1.2.3', enabled: true, source: 'bundle' }],
      })}\n`,
    );

    // The bundle must exist for import (without --force) to accept the entry.
    mkdirSync(join(fixturesRoot, 'cwd', 'storage', 'plugins', 'acme', '1.2.3'), {
      recursive: true,
    });
    writeFileSync(
      join(fixturesRoot, 'cwd', 'storage', 'plugins', 'acme', '1.2.3', 'manifest.json'),
      JSON.stringify({
        id: 'acme',
        version: '1.2.3',
        jsailsCompat: '>=0.1.0',
        entry: './index.js',
      }),
    );

    const code = await runPluginsCommand(
      ['import', 'snapshot.json'],
      lifecycleDeps(s, {
        loadAppPlugins: async () => ({ managed: true }),
        loadDataSource: async () => db.dataSource,
        createStateStore: stateSource.createStateStore,
      }),
    );

    assert.equal(code, 0);
    assert.deepEqual(stateSource.state.plugins['acme'], { active: '1.2.3', enabled: true });
    assert.match(s.out.join('\n'), /Imported 1 plugin/);
    assert.deepEqual(db.calls, ['initialize', 'destroy']);
  });

  it('checks bundles in the app config pluginsDir, with --dir as an override', async () => {
    const cwd = join(fixturesRoot, 'cwd');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      join(cwd, 'import-snapshot.json'),
      `${JSON.stringify({
        format: 'jsails.plugins',
        version: 1,
        plugins: [{ id: 'acme', version: '1.2.3', enabled: true, source: 'bundle' }],
      })}\n`,
    );
    const configured = join(fixturesRoot, 'import-root', 'var', 'plugins');
    writeBundle(configured, 'sha256-configured');

    const runImport = async (extra: readonly string[]) => {
      const stateSource = makeStateSource({});
      const s = sinks();
      const code = await runPluginsCommand(
        ['import', 'import-snapshot.json', ...extra],
        lifecycleDeps(s, {
          loadAppPlugins: async () => ({ managed: true, pluginsDir: configured }),
          loadDataSource: async () => makeDataSource().dataSource,
          createStateStore: stateSource.createStateStore,
        }),
      );
      return { code, plugins: stateSource.state.plugins, err: s.err.join('\n') };
    };

    const fromConfig = await runImport([]);
    assert.equal(fromConfig.code, 0, fromConfig.err);
    assert.deepEqual(fromConfig.plugins['acme'], { active: '1.2.3', enabled: true });

    // The override folder holds no bundle yet, so the entry is rejected there.
    const fromOverride = await runImport(['--dir', 'import-override']);
    assert.equal(fromOverride.code, 0, fromOverride.err);
    assert.match(fromOverride.err, /plugin "acme" was rejected \(missing_bundle\)/);
    assert.equal(fromOverride.plugins['acme'], undefined);

    writeBundle(join(cwd, 'import-override'), 'sha256-override');
    const fromFilledOverride = await runImport(['--dir', 'import-override']);
    assert.equal(fromFilledOverride.code, 0, fromFilledOverride.err);
    assert.deepEqual(fromFilledOverride.plugins['acme'], { active: '1.2.3', enabled: true });
  });

  it('merges: an installed plugin the snapshot does not list keeps its stored state', async () => {
    const cwd = join(fixturesRoot, 'cwd');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      join(cwd, 'merge-snapshot.json'),
      `${JSON.stringify({
        format: 'jsails.plugins',
        version: 1,
        plugins: [{ id: 'acme', version: '1.2.3', enabled: true, source: 'bundle' }],
      })}\n`,
    );
    const pluginsDir = join(fixturesRoot, 'merge-root', 'plugins');
    writeBundle(pluginsDir, 'sha256-merge');
    const shared = await openSharedStateDatabase();
    try {
      const store = shared.store();
      await store.putEntry('acme', { active: '1.0.0', enabled: false });
      await store.putEntry('other', { active: '2.0.0', enabled: true, settings: { a: 1 } });
      const s = sinks();

      const code = await runPluginsCommand(
        ['import', 'merge-snapshot.json'],
        lifecycleDeps(s, {
          loadAppPlugins: async () => ({ managed: true, pluginsDir }),
          loadDataSource: async () => shared.handle,
          createStateStore: () => shared.store(),
        }),
      );

      assert.equal(code, 0, s.err.join('\n'));
      assert.deepEqual((await store.load()).plugins, {
        acme: { active: '1.2.3', enabled: true },
        other: { active: '2.0.0', enabled: true, settings: { a: 1 } },
      });
    } finally {
      await shared.close();
    }
  });

  it('refuses a --dir that escapes cwd before opening the database', async () => {
    let opened = false;
    const s = sinks();
    const code = await runPluginsCommand(
      ['import', 'snapshot.json', '--dir', '../escape'],
      lifecycleDeps(s, {
        loadAppPlugins: async () => ({ managed: true }),
        loadDataSource: async () => {
          opened = true;
          return makeDataSource().dataSource;
        },
      }),
    );
    assert.equal(code, 1);
    assert.match(s.err.join('\n'), /escapes the working directory/);
    assert.equal(opened, false);
  });

  it('requires a <file> positional (exit 2)', async () => {
    const s = sinks();
    const code = await runPluginsCommand(['import'], lifecycleDeps(s));
    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /requires <file>/);
  });

  it('refuses when the deployment is not managed (exit 1)', async () => {
    const s = sinks();
    const code = await runPluginsCommand(
      ['import', 'snapshot.json'],
      lifecycleDeps(s, { loadAppPlugins: async () => undefined }),
    );
    assert.equal(code, 1);
    assert.match(s.err.join('\n'), /not managed/);
  });
});
