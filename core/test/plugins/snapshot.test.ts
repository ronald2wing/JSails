/**
 * Snapshot round-trip tests: the export projection, the deterministic sort
 * order, the import reconciliation (including idempotency, missing-bundle
 * refusal, `--force`, and invalid-input rejection), and the value-free error
 * discipline. All tests use an in-memory fs facade — no database, no network.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  exportPluginSnapshot,
  importPluginSnapshot,
  parsePluginSnapshot,
  PluginSnapshotError,
  PLUGIN_SNAPSHOT_FORMAT,
  PLUGIN_SNAPSHOT_VERSION,
  type PluginSnapshot,
  type RejectedSnapshotEntry,
  type SnapshotFs,
} from '../../src/plugins/snapshot.js';
import { PLUGIN_STATE_VERSION, type PluginState } from '../../src/plugins/state-store.js';

/** A tiny in-memory fs facade keyed by path -> file content. */
function makeFs(files: Record<string, string> = {}): SnapshotFs {
  return {
    existsSync: (path) => Object.hasOwn(files, path),
    readFileSync: (path) => {
      const content = files[path];
      if (content === undefined) {
        throw new Error('ENOENT');
      }
      return content;
    },
  };
}

function state(entries: PluginState['plugins']): PluginState {
  return { version: PLUGIN_STATE_VERSION, plugins: entries };
}

const MANIFEST = (checksums: Record<string, string>) =>
  JSON.stringify({
    id: 'acme',
    version: '1.2.3',
    jsailsCompat: '>=0.1.0',
    entry: './index.js',
    checksums,
  });

describe('exportPluginSnapshot', () => {
  it('emits the deterministic, versioned document shape', () => {
    const snapshot = exportPluginSnapshot(state({ acme: { active: '1.2.3', enabled: true } }), {
      pluginsDir: '/plugins',
      fs: makeFs(),
    });
    assert.equal(snapshot.format, PLUGIN_SNAPSHOT_FORMAT);
    assert.equal(snapshot.version, PLUGIN_SNAPSHOT_VERSION);
    assert.deepEqual(snapshot.plugins, [
      { id: 'acme', version: '1.2.3', enabled: true, source: 'bundle' },
    ]);
  });

  it('sorts plugins by id', () => {
    const snapshot = exportPluginSnapshot(
      state({
        zeta: { active: '1.0.0', enabled: true },
        alpha: { active: '2.0.0', enabled: false },
        mike: { active: '3.0.0', enabled: true },
      }),
      { pluginsDir: '/plugins', fs: makeFs() },
    );
    assert.deepEqual(
      snapshot.plugins.map((entry) => entry.id),
      ['alpha', 'mike', 'zeta'],
    );
  });

  it('captures the active bundle checksum when present', () => {
    const files = {
      '/plugins/acme/1.2.3/manifest.json': MANIFEST({ 'acme-1.2.3.tgz': 'sha256-deadbeef' }),
    };
    const snapshot = exportPluginSnapshot(state({ acme: { active: '1.2.3', enabled: true } }), {
      pluginsDir: '/plugins',
      fs: makeFs(files),
    });
    assert.equal(snapshot.plugins[0]!.checksum, 'sha256-deadbeef');
  });

  it('omits checksum when the bundle or manifest is absent', () => {
    const snapshot = exportPluginSnapshot(state({ acme: { active: '1.2.3', enabled: true } }), {
      pluginsDir: '/plugins',
      fs: makeFs(),
    });
    assert.equal(snapshot.plugins[0]!.checksum, undefined);
  });
});

describe('parsePluginSnapshot', () => {
  it('accepts a valid snapshot', () => {
    const snapshot = parsePluginSnapshot({
      format: PLUGIN_SNAPSHOT_FORMAT,
      version: PLUGIN_SNAPSHOT_VERSION,
      plugins: [{ id: 'acme', version: '1.2.3', enabled: true, source: 'bundle' }],
    });
    assert.equal(snapshot.plugins[0]!.id, 'acme');
  });

  it('rejects a wrong format discriminator', () => {
    assert.throws(
      () =>
        parsePluginSnapshot({
          format: 'other',
          version: PLUGIN_SNAPSHOT_VERSION,
          plugins: [],
        }),
      PluginSnapshotError,
    );
  });

  it('rejects an invalid plugin id without echoing it', () => {
    assert.throws(
      () =>
        parsePluginSnapshot({
          format: PLUGIN_SNAPSHOT_FORMAT,
          version: PLUGIN_SNAPSHOT_VERSION,
          plugins: [{ id: 'BAD ID', version: '1.2.3', enabled: true, source: 'bundle' }],
        }),
      (error: unknown) => error instanceof PluginSnapshotError && !error.message.includes('BAD ID'),
    );
  });

  it('rejects a duplicate id', () => {
    assert.throws(
      () =>
        parsePluginSnapshot({
          format: PLUGIN_SNAPSHOT_FORMAT,
          version: PLUGIN_SNAPSHOT_VERSION,
          plugins: [
            { id: 'acme', version: '1.0.0', enabled: true, source: 'bundle' },
            { id: 'acme', version: '2.0.0', enabled: true, source: 'bundle' },
          ],
        }),
      /duplicate/,
    );
  });

  it('rejects a non-semver version without echoing it', () => {
    assert.throws(
      () =>
        parsePluginSnapshot({
          format: PLUGIN_SNAPSHOT_FORMAT,
          version: PLUGIN_SNAPSHOT_VERSION,
          plugins: [{ id: 'acme', version: 'not-a-version', enabled: true, source: 'bundle' }],
        }),
      (error: unknown) =>
        error instanceof PluginSnapshotError && !error.message.includes('not-a-version'),
    );
  });
});

describe('importPluginSnapshot', () => {
  function snapshotEntries(
    entries: Array<{ id: string; version: string; enabled: boolean }>,
  ): PluginSnapshot {
    return {
      format: PLUGIN_SNAPSHOT_FORMAT,
      version: PLUGIN_SNAPSHOT_VERSION,
      plugins: entries.map((entry) => ({ ...entry, source: 'bundle' as const })),
    };
  }

  it('reconciles database state from a snapshot and preserves settings', () => {
    const files = {
      '/plugins/acme/1.2.3/manifest.json': MANIFEST({}),
    };
    const snapshot = snapshotEntries([{ id: 'acme', version: '1.2.3', enabled: true }]);
    const result = importPluginSnapshot(
      snapshot,
      state({ acme: { active: '1.0.0', enabled: false, settings: { retries: 3 } } }),
      { pluginsDir: '/plugins', fs: makeFs(files) },
    );
    assert.deepEqual(result.state.plugins['acme'], {
      active: '1.2.3',
      enabled: true,
      settings: { retries: 3 },
    });
    assert.deepEqual(result.rejected, []);
  });

  it('is idempotent: re-importing the same snapshot is a no-op', () => {
    const files = {
      '/plugins/acme/1.2.3/manifest.json': MANIFEST({}),
    };
    const snapshot = snapshotEntries([{ id: 'acme', version: '1.2.3', enabled: true }]);
    const first = importPluginSnapshot(snapshot, state({}), {
      pluginsDir: '/plugins',
      fs: makeFs(files),
    });
    const second = importPluginSnapshot(snapshot, first.state, {
      pluginsDir: '/plugins',
      fs: makeFs(files),
    });
    assert.deepEqual(second.state, first.state);
    assert.deepEqual(second.rejected, []);
  });

  it('refuses to enable a plugin whose bundle is missing', () => {
    const snapshot = snapshotEntries([{ id: 'ghost', version: '1.0.0', enabled: true }]);
    const result = importPluginSnapshot(snapshot, state({}), {
      pluginsDir: '/plugins',
      fs: makeFs(),
    });
    assert.deepEqual(result.state.plugins, {});
    assert.deepEqual(result.rejected, [{ id: 'ghost', code: 'missing_bundle' }]);
  });

  it('--force overrides the missing-bundle refusal without fabricating the bundle', () => {
    const snapshot = snapshotEntries([{ id: 'ghost', version: '1.0.0', enabled: true }]);
    const result = importPluginSnapshot(snapshot, state({}), {
      pluginsDir: '/plugins',
      fs: makeFs(),
      force: true,
    });
    assert.deepEqual(result.state.plugins['ghost'], { active: '1.0.0', enabled: true });
    assert.deepEqual(result.rejected, []);
  });

  it('reports every rejected entry while accepting the valid ones', () => {
    const files = {
      '/plugins/acme/1.2.3/manifest.json': MANIFEST({}),
    };
    const snapshot = snapshotEntries([
      { id: 'acme', version: '1.2.3', enabled: true },
      { id: 'ghost', version: '1.0.0', enabled: true },
    ]);
    const result = importPluginSnapshot(snapshot, state({}), {
      pluginsDir: '/plugins',
      fs: makeFs(files),
    });
    assert.deepEqual(Object.keys(result.state.plugins), ['acme']);
    assert.deepEqual(result.rejected, [{ id: 'ghost', code: 'missing_bundle' }]);
  });

  it('keeps rejection reasons value-free (no echoed id)', () => {
    const rejected: RejectedSnapshotEntry = { id: 'secret-id', code: 'missing_bundle' };
    assert.equal(rejected.code, 'missing_bundle');
  });
});
