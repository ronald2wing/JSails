/**
 * Tests for the `config:export` and `config:import` commands this package
 * declares in its `jsails.commands`: each runs over the services the `config`
 * plugin provides, so the sets, store and sync directory are the app's.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { cachePlugin } from '@jsails/cache';
import { runExtensions } from 'jsails/extensions';
import { runCommand, tempDir, type RunCommandOptions } from 'jsails/testing';

import exportCommand from '../src/commands/export.js';
import importCommand from '../src/commands/import.js';
import { configPlugin, configToken, type ConfigPluginOptions } from '../src/index.js';
import { siteConfig } from './fixtures.js';

const ENV = { JSAILS_ENV: 'test', NODE_ENV: 'test' };

type ServicesStage = NonNullable<RunCommandOptions<{ services: [] }>['stages']>;

/** The app's services with the config plugin set up at `root`, closed with the test. */
async function services(t: TestContext, root: string, options: ConfigPluginOptions) {
  const runtime = await runExtensions([cachePlugin({ store: 'memory' }), configPlugin(options)], {
    rootDir: root,
  });
  t.after(() => runtime.close());
  // The commands read the service registry alone; the rest of the services
  // stage (the graph, the units) is the dispatcher's.
  const stages = { services: { registry: runtime.services } } as unknown as ServicesStage;
  return { config: runtime.services.get(configToken), stages };
}

function sitePath(root: string, dir = join('config', 'sync')): string {
  return join(root, dir, 'site.json');
}

describe('config commands', () => {
  it('exports the active config, then imports it into another app', async (t) => {
    const root = tempDir(t);
    const source = await services(t, root, { sets: [siteConfig] });
    await source.config.set(siteConfig, { title: 'Exported' });

    const exported = await runCommand(exportCommand, {
      env: ENV,
      cwd: root,
      stages: source.stages,
    });
    assert.equal(exported.code, 0, exported.stderr.join('\n'));
    assert.deepEqual(exported.stdout, ['wrote site']);
    assert.match(readFileSync(sitePath(root), 'utf8'), /"Exported"/);

    const target = await services(t, root, { sets: [siteConfig] });
    const dryRun = await runCommand(importCommand, {
      args: ['--dry-run'],
      env: ENV,
      cwd: root,
      stages: target.stages,
    });
    assert.equal(dryRun.code, 0);
    assert.deepEqual(dryRun.stdout, ['would update site: title']);
    assert.equal((await target.config.get(siteConfig)).title, 'My site');

    const applied = await runCommand(importCommand, { env: ENV, cwd: root, stages: target.stages });
    assert.equal(applied.code, 0);
    assert.deepEqual(applied.stdout, ['updated site: title']);
    assert.equal((await target.config.get(siteConfig)).title, 'Exported');
  });

  it('writes to the plugin syncDir against the app root, and --dir against the working directory', async (t) => {
    const root = tempDir(t);
    const cwd = tempDir(t);
    const { stages } = await services(t, root, { sets: [siteConfig], syncDir: 'settings' });

    await runCommand(exportCommand, { env: ENV, cwd, stages });
    assert.ok(existsSync(sitePath(root, 'settings')));
    await runCommand(exportCommand, { args: ['--dir', 'elsewhere'], env: ENV, cwd, stages });
    assert.ok(existsSync(sitePath(cwd, 'elsewhere')));
  });

  it('reports a refused import value-free and exits 1', async (t) => {
    const root = tempDir(t);
    const { stages } = await services(t, root, { sets: [siteConfig] });
    await runCommand(exportCommand, { env: ENV, cwd: root, stages });
    writeFileSync(
      sitePath(root),
      JSON.stringify({
        format: 'jsails.config',
        version: 1,
        set: 'site',
        values: { perPage: 4242 },
      }),
    );

    const result = await runCommand(importCommand, { env: ENV, cwd: root, stages });
    assert.equal(result.code, 1);
    assert.equal(result.stderr.length, 1);
    assert.match(result.stderr[0]!, /site\.perPage/);
    assert.ok(!result.stderr[0]!.includes('4242'));
  });

  it('refuses a flag the command does not declare', async (t) => {
    const root = tempDir(t);
    const { stages } = await services(t, root, { sets: [siteConfig] });
    const result = await runCommand(exportCommand, {
      args: ['--dry-run'],
      env: ENV,
      cwd: root,
      stages,
    });
    assert.equal(result.code, 2);
    assert.deepEqual(result.stderr, ['jsails: unknown option --dry-run']);
  });

  it('is declared in the package manifest under the modules it is exported from', () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
    ) as {
      exports: Record<string, unknown>;
      jsails: { commands: readonly { name: string; summary: string; module: string }[] };
    };
    assert.deepEqual(manifest.jsails.commands, [
      {
        name: 'config:export',
        summary: exportCommand.summary,
        module: '@jsails/config/commands/export',
      },
      {
        name: 'config:import',
        summary: importCommand.summary,
        module: '@jsails/config/commands/import',
      },
    ]);
    for (const { module } of manifest.jsails.commands) {
      assert.ok(`.${module.slice('@jsails/config'.length)}` in manifest.exports, module);
    }
  });
});
