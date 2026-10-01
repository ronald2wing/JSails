/**
 * The conformance driver for today's kernel: a real `createApplication` boot
 * through `createLoadedApp`, with no marketplace behind it. It states what
 * the kernel does now that the old installer, state store and activation are
 * gone and before `@jsails/marketplace` exists, so each scenario passes or
 * fails for a real reason and the ledger names the package that closes it.
 *
 * The mapping:
 *
 * - mode: `plugins.activation: { mode }` in the app config, as owner
 *   decision 1 requires. Managed mode activates nothing yet: no plugin source
 *   exists until MKT-05.
 * - there is no activation store, so `storeCalls` is always 0 and
 *   `throwingStore` has nothing to hand to.
 * - the attacker's table is inert: `sqlWrite` records the row and
 *   `status().rows` returns it, and no boot reads it. There is no bundle
 *   store: `putBundle` names the bundle it was handed and keeps no bytes.
 * - there is no admin surface: every `adminAction` is `unsupported`.
 * - `safeMode` boots through the kernel's safe mode.
 * - boot config without a counterpart today (`publishers`, `ceiling`,
 *   `revoked`, `required`, `lock`) is accepted and has no effect; `code`
 *   plugins are app extensions, which is what `plugins.use` produces.
 *
 * Deleted in MKT-15b, once the `@jsails/marketplace` driver passes every
 * scenario.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApplication, type Application } from '../../../src/app/application.js';
import type { JsailsPlugin } from '../../../src/extensions/plugin-contract.js';
import { createLoadedApp } from '../../../src/kernel/load-app.js';
import { RECORDER_KEY, type BuiltBundle, type BundleRecorder } from './bundles.js';
import type {
  ActivationMode,
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

/** The activation table MKT-07 creates, which an attacker who knows the schema targets. */
const ACTIVATION_TABLE = 'jsails_plugin_activation';

interface KernelNode {
  readonly dir: string;
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

/** The value-free codes in a boot error message: `id (code)` and `id (code: detail)`. */
function issueCodes(message: string): string[] {
  return [...message.matchAll(/ \(([a-z][a-z_]*)(?::[^)]*)?\)/g)].map((match) => match[1] ?? '');
}

/** Build a fresh deployment over today's kernel. */
export async function createKernelDriver(): Promise<MarketplaceDriver> {
  const root = mkdtempSync(join(tmpdir(), 'jsails-mkt-conformance-'));
  const rows = new Map<string, Readonly<Record<string, unknown>>[]>();
  const nodes: KernelNode[] = [];

  function addNode(): KernelNode {
    const node: KernelNode = { dir: join(root, `node-${nodes.length}`), running: undefined };
    mkdirSync(node.dir, { recursive: true });
    nodes.push(node);
    return node;
  }
  const primary = addNode();

  async function closeRunning(node: KernelNode): Promise<void> {
    const running = node.running;
    node.running = undefined;
    if (running !== undefined) await running.app.close();
  }

  async function boot(
    node: KernelNode,
    mode: ActivationMode,
    config: BootConfig = {},
  ): Promise<BootReport> {
    await closeRunning(node);
    const loaded: string[] = [];
    const imported: string[] = [];
    const settings: Record<string, unknown> = {};
    const issues: string[] = [];
    const recorder: BundleRecorder = {
      imported: (label) => imported.push(label),
      setup: (label, value) => {
        loaded.push(label);
        if (value !== undefined) settings[label.slice(0, label.indexOf('@'))] = value;
      },
    };
    const savedEnv = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(config.env ?? {})) {
      savedEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
    const slot = globalThis as Record<symbol, BundleRecorder | undefined>;
    slot[RECORDER_KEY] = recorder;
    let failure: string | undefined;
    try {
      const loadedApp = createLoadedApp(
        {
          rootDir: node.dir,
          port: 0,
          ...(config.shape === undefined ? {} : { shape: config.shape }),
          plugins: { activation: { mode } },
          extensions: (config.code ?? []).map(codePlugin),
        },
        { cwd: node.dir },
      );
      const app = await createApplication(loadedApp, {
        ...(config.safeMode === undefined ? {} : { safeMode: config.safeMode }),
      });
      node.running = { app, loaded: [...loaded] };
    } catch (error) {
      failure = error instanceof Error ? error.message : 'boot failed';
      issues.push(...issueCodes(failure));
    } finally {
      delete slot[RECORDER_KEY];
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    return {
      booted: failure === undefined,
      ...(failure === undefined ? {} : { failure }),
      loaded,
      imported,
      issues,
      storeCalls: 0,
      settings,
    };
  }

  async function putBundle(
    bundle: BuiltBundle,
    options: { readonly replacing?: BundleRef } = {},
  ): Promise<BundleRef> {
    const target = options.replacing ?? bundle;
    return { id: target.id, version: target.version, digest: target.digest };
  }

  async function sqlWrite(table: string, row: Readonly<Record<string, unknown>>): Promise<void> {
    const tableRows = rows.get(table) ?? [];
    const index = tableRows.findIndex((existing) => existing['pluginId'] === row['pluginId']);
    if (index === -1) tableRows.push({ ...row });
    else tableRows[index] = { ...row };
    rows.set(table, tableRows);
  }

  async function status(): Promise<DeploymentStatus> {
    return {
      rows: [...(rows.get(ACTIVATION_TABLE) ?? [])],
      running: primary.running?.loaded ?? [],
    };
  }

  function forgeRow(activation: ForgedActivation): ForgedRow {
    return {
      table: ACTIVATION_TABLE,
      row: {
        pluginId: activation.id,
        version: activation.version,
        enabled: activation.enabled,
      },
    };
  }

  return {
    boot: (mode, config) => boot(primary, mode, config),
    sqlWrite,
    adminAction: async (): Promise<AdminOutcome> => ({ ok: false, code: 'unsupported' }),
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
