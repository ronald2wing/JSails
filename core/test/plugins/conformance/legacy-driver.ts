/**
 * The conformance driver for today's implementation: `core/src/plugins`
 * (installer, database state store, discovery and activation) behind a real
 * `createApplication` boot, with the state table in an on-disk sql.js
 * database every node opens on its own.
 *
 * The mapping, and the places today's code has nothing to map onto:
 *
 * - mode: `locked` boots with `plugins.managed: false`, `managed` with
 *   `plugins.managed: true` and the database state source. Both are app
 *   config, as owner decision 1 requires.
 * - `sqlWrite` and `status().rows` act on `jsails_plugin_state` through raw
 *   SQL. `forgeRow` ignores `withSealKey`: rows carry no seal today.
 * - the bundle store is the primary node's plugins folder. Today bundles live
 *   only on the node that installed them; there is no store other nodes read.
 *   `putBundle` with `replacing` deletes the stored files and writes the new
 *   bytes' files in their place.
 * - every boot is a fresh process: it runs from a copy of the node's plugins
 *   folder at a path no earlier boot used. Node caches an ES module by URL, so
 *   a second boot over the same folder would reuse the module an earlier boot
 *   evaluated, run its stale code after the bytes changed, and record no
 *   evaluation (`BootReport.imported`).
 * - `adminAction` is what `@jsails/admin-plugin-manager` does after its own
 *   checks: install, uninstall and rollback through the installer (with the
 *   SHA-256 the directory supplies), enable, disable and settings through
 *   `putEntry`. Core has no actor model, so the actor is not consulted, and
 *   there is no signed catalog or mode operation (`unsupported`).
 * - boot config without a counterpart today (`publishers`, `ceiling`,
 *   `revoked`, `required`, `lock`, `safeMode`) is accepted and has no effect;
 *   `code` plugins are app extensions, which is what `plugins.use` produces.
 *
 * Deleted with the old mechanism in MKT-15.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createApplication, type Application } from '../../../src/app/application.js';
import { validateAppConfig } from '../../../src/app/config/index.js';
import { JsailsDataSource } from '../../../src/database/data-source.js';
import type { JsailsPlugin } from '../../../src/extensions/plugin-contract.js';
import { extractBundle, flattenBundleEntries } from '../../../src/plugins/bundle-intake.js';
import { DatabasePluginState } from '../../../src/plugins/database-state-entity.js';
import { createDatabasePluginStateStore } from '../../../src/plugins/database-state-store.js';
import { createPluginInstaller, PluginInstallerError } from '../../../src/plugins/installer.js';
import type { PluginStateSource } from '../../../src/plugins/state-store.js';
import { createEmptyDataSource } from '../../../src/testing/index.js';
import { RECORDER_KEY, type BuiltBundle, type BundleRecorder } from './bundles.js';
import type {
  ActivationMode,
  Actor,
  AdminAction,
  AdminOutcome,
  BootConfig,
  BootReport,
  BundleRef,
  DeploymentStatus,
  ForgedActivation,
  ForgedRow,
  MarketplaceDriver,
  MarketplaceNode,
} from './driver.js';

const STATE_TABLE = 'jsails_plugin_state';
const BUNDLE_ORIGIN = 'https://bundles.conformance.test';
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ISSUE_PREFIX = 'jsails: managed plugin issue: ';

interface LegacyNode {
  readonly dir: string;
  readonly pluginsDir: string;
  running: { readonly app: Application; readonly loaded: readonly string[] } | undefined;
}

/** A plugin the app's own code declares, recording its setup as `id@code`. */
function codePlugin(id: string): JsailsPlugin {
  return {
    name: id,
    setup() {
      (globalThis as Record<symbol, BundleRecorder | undefined>)[RECORDER_KEY]?.setup(
        `${id}@code`,
        undefined,
      );
    },
  };
}

/** A state source whose every call throws, counting the calls. */
function throwingSource(count: () => void): PluginStateSource {
  const fail = (): never => {
    count();
    throw new Error('the activation store must not be called');
  };
  return { load: fail, save: fail, putEntry: fail, removeEntry: fail };
}

/** Wrap a state source so every call is counted. */
function countingSource(inner: PluginStateSource, count: () => void): PluginStateSource {
  return {
    load() {
      count();
      return inner.load();
    },
    save(state) {
      count();
      return inner.save(state);
    },
    putEntry(id, entry) {
      count();
      return inner.putEntry(id, entry);
    },
    removeEntry(id) {
      count();
      return inner.removeEntry(id);
    },
  };
}

/** The value-free codes in a boot error or issue message: `id (code)` and `id (code: detail)`. */
function issueCodes(message: string): string[] {
  return [...message.matchAll(/ \(([a-z][a-z_]*)(?::[^)]*)?\)/g)].map((match) => match[1] ?? '');
}

function sqlValue(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  return value;
}

/** Build a fresh deployment over today's implementation. */
export async function createLegacyDriver(): Promise<MarketplaceDriver> {
  const root = mkdtempSync(join(tmpdir(), 'jsails-mkt-conformance-'));
  const location = join(root, 'database', 'state.db');
  mkdirSync(dirname(location), { recursive: true });
  // The table comes from the entity, as `db:push` creates it in an app.
  const setup = await createEmptyDataSource([DatabasePluginState], { location });
  await setup.destroy();

  const served = new Map<string, Uint8Array>();
  const nodes: LegacyNode[] = [];
  let boots = 0;

  function addNode(): LegacyNode {
    const dir = join(root, `node-${nodes.length}`);
    const node: LegacyNode = {
      dir,
      pluginsDir: join(dir, 'storage', 'plugins'),
      running: undefined,
    };
    mkdirSync(node.pluginsDir, { recursive: true });
    nodes.push(node);
    return node;
  }
  const primary = addNode();

  /** A data source over the shared file, opened for one operation, as a separate process would. */
  async function withDatabase<T>(task: (dataSource: JsailsDataSource) => Promise<T>): Promise<T> {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location,
      entities: [DatabasePluginState],
    });
    await dataSource.initialize();
    try {
      return await task(dataSource);
    } finally {
      await dataSource.destroy();
    }
  }

  /** The state source an app process opens, and its release. */
  function openStore(): {
    readonly source: PluginStateSource;
    readonly close: () => Promise<void>;
  } {
    let opened: JsailsDataSource | undefined;
    const source = createDatabasePluginStateStore({
      getDataSource: () => {
        opened ??= new JsailsDataSource({
          type: 'sqljs',
          location,
          entities: [DatabasePluginState],
        });
        return opened;
      },
    });
    return {
      source,
      close: async () => {
        if (opened?.isInitialized === true) await opened.destroy();
      },
    };
  }

  async function closeRunning(node: LegacyNode): Promise<void> {
    const running = node.running;
    node.running = undefined;
    if (running !== undefined) await running.app.close();
  }

  async function boot(
    node: LegacyNode,
    mode: ActivationMode,
    config: BootConfig = {},
  ): Promise<BootReport> {
    await closeRunning(node);
    boots += 1;
    const pluginsDir = join(node.dir, 'boots', String(boots), 'plugins');
    cpSync(node.pluginsDir, pluginsDir, { recursive: true });
    const loaded: string[] = [];
    const imported: string[] = [];
    const settings: Record<string, unknown> = {};
    const issues: string[] = [];
    let storeCalls = 0;
    const count = (): void => {
      storeCalls += 1;
    };
    const recorder: BundleRecorder = {
      imported: (label) => imported.push(label),
      setup: (label, value) => {
        loaded.push(label);
        if (value !== undefined) settings[label.slice(0, label.indexOf('@'))] = value;
      },
    };
    const onWarning = (warning: Error): void => {
      if (warning.message.startsWith(ISSUE_PREFIX)) issues.push(...issueCodes(warning.message));
    };
    const store = config.throwingStore === true ? undefined : openStore();
    const stateSource =
      store === undefined ? throwingSource(count) : countingSource(store.source, count);
    const savedEnv = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(config.env ?? {})) {
      savedEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
    const slot = globalThis as Record<symbol, BundleRecorder | undefined>;
    slot[RECORDER_KEY] = recorder;
    process.on('warning', onWarning);
    let failure: string | undefined;
    try {
      const appConfig = validateAppConfig(
        {
          rootDir: node.dir,
          port: 0,
          ...(config.shape === undefined ? {} : { shape: config.shape }),
          plugins: { managed: mode === 'managed', stateSource, pluginsDir },
          extensions: (config.code ?? []).map(codePlugin),
        },
        { cwd: node.dir },
      );
      const app = await createApplication(appConfig);
      node.running = { app, loaded: [...loaded] };
    } catch (error) {
      failure = error instanceof Error ? error.message : 'boot failed';
      issues.push(...issueCodes(failure));
    } finally {
      // process.emitWarning delivers on a later tick.
      await new Promise((resolve) => setImmediate(resolve));
      process.off('warning', onWarning);
      delete slot[RECORDER_KEY];
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await store?.close();
    }
    return {
      booted: failure === undefined,
      ...(failure === undefined ? {} : { failure }),
      loaded,
      imported,
      issues,
      storeCalls,
      settings,
    };
  }

  async function adminAction(_actor: Actor, action: AdminAction): Promise<AdminOutcome> {
    const store = openStore();
    const installer = createPluginInstaller({
      pluginsDir: primary.pluginsDir,
      stateStore: store.source,
      // The registry is in memory: the outbound guard has its own tests, and
      // these scenarios are about what an install writes, not how it travels.
      fetch: async (url) => {
        const bytes = served.get(url);
        return {
          status: bytes === undefined ? 404 : 200,
          headers: new Headers(),
          bytes: new Uint8Array(bytes ?? []),
          url,
        };
      },
    });
    try {
      switch (action.kind) {
        case 'install': {
          const url = `${BUNDLE_ORIGIN}/${action.bundle.digest}.tgz`;
          await installer.install({
            id: action.bundle.id,
            version: action.bundle.version,
            url,
            checksums: { [`${action.bundle.digest}.tgz`]: action.bundle.digest },
          });
          return { ok: true };
        }
        case 'remove':
          await installer.uninstall(action.id);
          return { ok: true };
        case 'rollback':
          await installer.rollback(action.id, action.version);
          return { ok: true };
        case 'enable':
        case 'disable':
        case 'settings': {
          const entry = (await store.source.load()).plugins[action.id];
          if (entry === undefined) return { ok: false, code: 'unknown_plugin' };
          await store.source.putEntry(
            action.id,
            action.kind === 'settings'
              ? { ...entry, settings: { ...action.values } }
              : { ...entry, enabled: action.kind === 'enable' },
          );
          return { ok: true };
        }
        case 'refreshCatalog':
        case 'setMode':
          return { ok: false, code: 'unsupported' };
      }
    } catch (error) {
      if (error instanceof PluginInstallerError) return { ok: false, code: error.code };
      throw error;
    } finally {
      await store.close();
    }
  }

  async function putBundle(
    bundle: BuiltBundle,
    options: { readonly replacing?: BundleRef } = {},
  ): Promise<BundleRef> {
    const target = options.replacing ?? bundle;
    served.set(`${BUNDLE_ORIGIN}/${target.digest}.tgz`, bundle.bytes);
    const dir = join(primary.pluginsDir, target.id, target.version);
    rmSync(dir, { recursive: true, force: true });
    for (const [path, data] of flattenBundleEntries(extractBundle(bundle.bytes))) {
      const file = join(dir, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, data);
    }
    return { id: target.id, version: target.version, digest: target.digest };
  }

  async function sqlWrite(table: string, row: Readonly<Record<string, unknown>>): Promise<void> {
    const columns = Object.keys(row).filter((column) => column !== 'id');
    if (!IDENTIFIER.test(table) || !columns.every((column) => IDENTIFIER.test(column))) {
      throw new TypeError('sqlWrite takes plain identifiers');
    }
    await withDatabase(async (dataSource) => {
      const pluginId = row['pluginId'];
      const existing = await dataSource.query<{ id: number }[]>(
        `SELECT "id" FROM "${table}" WHERE "pluginId" = ? ORDER BY "id" LIMIT 1`,
        [pluginId],
      );
      const values = columns.map((column) => sqlValue(row[column]));
      const first = existing[0];
      if (first !== undefined) {
        const assignments = columns.map((column) => `"${column}" = ?`).join(', ');
        await dataSource.query(`UPDATE "${table}" SET ${assignments} WHERE "id" = ?`, [
          ...values,
          first.id,
        ]);
        return;
      }
      const insertColumns = columns.includes('updatedAt') ? columns : [...columns, 'updatedAt'];
      const insertValues = columns.includes('updatedAt')
        ? values
        : [...values, new Date().toISOString()];
      await dataSource.query(
        `INSERT INTO "${table}" (${insertColumns.map((column) => `"${column}"`).join(', ')}) ` +
          `VALUES (${insertColumns.map(() => '?').join(', ')})`,
        insertValues,
      );
    });
  }

  async function status(): Promise<DeploymentStatus> {
    const rows = await withDatabase((dataSource) =>
      dataSource.query<Record<string, unknown>[]>(`SELECT * FROM "${STATE_TABLE}" ORDER BY "id"`),
    );
    return { rows, running: primary.running?.loaded ?? [] };
  }

  function forgeRow(activation: ForgedActivation): ForgedRow {
    return {
      table: STATE_TABLE,
      row: {
        pluginId: activation.id,
        activeVersion: activation.version,
        enabled: activation.enabled,
        settings: null,
      },
    };
  }

  return {
    boot: (mode, config) => boot(primary, mode, config),
    sqlWrite,
    adminAction,
    putBundle,
    async nodes(count) {
      const added: MarketplaceNode[] = [];
      for (let i = 0; i < count; i += 1) {
        const node = addNode();
        added.push({ boot: (mode, config) => boot(node, mode, config) });
      }
      return added;
    },
    status,
    forgeRow,
    async close() {
      for (const node of nodes) await closeRunning(node);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
