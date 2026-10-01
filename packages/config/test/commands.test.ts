/** Tests for the `config:export` and `config:import` commands the plugin contributes. */

import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import type { CliCommand, CliCommandContext } from 'jsails/extensions';
import { tempDir } from 'jsails/testing';

import { configPlugin, createMemoryConfigStore, type ConfigStore } from '../src/index.js';
import { siteConfig } from './fixtures.js';

function context(t: TestContext) {
  const root = tempDir(t);
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliCommandContext = {
    configPath: join(root, 'jsails.app.js'),
    cwd: '/',
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  };
  return { root, out, err, ctx };
}

function command(plugin: { commands?: readonly CliCommand[] }, name: string): CliCommand {
  const found = plugin.commands?.find((candidate) => candidate.name === name);
  assert.ok(found, name);
  return found;
}

function closingStore(): ConfigStore & { closed: number } {
  const inner = createMemoryConfigStore();
  return {
    closed: 0,
    read: (name) => inner.read(name),
    write: (entries) => inner.write(entries),
    async close() {
      this.closed += 1;
    },
  };
}

describe('config commands', () => {
  it('exports beside the app config, then imports, closing the store each time', async (t) => {
    const { root, out, err, ctx } = context(t);
    const store = closingStore();
    const plugin = configPlugin({ sets: [siteConfig], store });
    await plugin.config.set(siteConfig, { title: 'Exported' });

    assert.equal(await command(plugin, 'config:export').run([], ctx), 0, err.join('\n'));
    assert.ok(existsSync(join(root, 'config', 'sync', 'site.json')));
    assert.deepEqual(out, ['wrote site']);
    assert.equal(store.closed, 1);

    const target = configPlugin({ sets: [siteConfig] });
    out.length = 0;
    assert.equal(await command(target, 'config:import').run(['--dry-run'], ctx), 0);
    assert.deepEqual(out, ['would update site: title']);
    assert.equal((await target.config.get(siteConfig)).title, 'My site');
    out.length = 0;
    assert.equal(await command(target, 'config:import').run([], ctx), 0);
    assert.deepEqual(out, ['updated site: title']);
    assert.equal((await target.config.get(siteConfig)).title, 'Exported');
  });

  it('honors --dir and the plugin syncDir', async (t) => {
    const { root, ctx } = context(t);
    const plugin = configPlugin({ sets: [siteConfig], syncDir: 'settings' });
    await command(plugin, 'config:export').run([], ctx);
    assert.ok(existsSync(join(root, 'settings', 'site.json')));
    await command(plugin, 'config:export').run(['--dir', 'elsewhere'], ctx);
    assert.ok(existsSync(join(root, 'elsewhere', 'site.json')));
  });

  it('reports a refused import value-free and exits 1', async (t) => {
    const { root, err, ctx } = context(t);
    const plugin = configPlugin({ sets: [siteConfig] });
    await command(plugin, 'config:export').run([], ctx);
    writeFileSync(
      join(root, 'config', 'sync', 'site.json'),
      JSON.stringify({
        format: 'jsails.config',
        version: 1,
        set: 'site',
        values: { perPage: 4242 },
      }),
    );
    assert.equal(await command(plugin, 'config:import').run([], ctx), 1);
    assert.equal(err.length, 1);
    assert.match(err[0]!, /site\.perPage/);
    assert.ok(!err[0]!.includes('4242'));
  });

  it('exits 2 on an unknown flag', async (t) => {
    const { err, ctx } = context(t);
    const plugin = configPlugin({ sets: [siteConfig] });
    assert.equal(await command(plugin, 'config:export').run(['--dry-run'], ctx), 2);
    assert.match(err[0]!, /usage/);
  });
});
