/** Tests for config sync: deterministic export, planned all-or-nothing import, and file checks. */

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { tempDir } from 'jsails/testing';

import {
  ConfigError,
  applyImport,
  createConfig,
  createMemoryConfigStore,
  exportConfig,
  planImport,
} from '../src/index.js';
import { mailConfig, siteConfig } from './fixtures.js';

function makeConfig(overrides = {}) {
  return createConfig({
    store: createMemoryConfigStore(),
    sets: [siteConfig, mailConfig],
    overrides,
  });
}

function syncDir(t: TestContext): string {
  return join(tempDir(t), 'config', 'sync');
}

function rejectsWith(code: ConfigError['code']): (error: unknown) => boolean {
  return (error: unknown) => error instanceof ConfigError && error.code === code;
}

describe('exportConfig', () => {
  it('writes one sorted, newline-terminated file per set, and is idempotent', async (t) => {
    const config = makeConfig();
    await config.set(siteConfig, { title: 'Hello', links: { home: '/' } });
    const dir = syncDir(t);
    const first = await exportConfig(config, dir);
    assert.deepEqual(first.written, ['site', 'mail.sender']);
    const text = readFileSync(join(dir, 'site.json'), 'utf8');
    assert.ok(text.endsWith('}\n'));
    const document = JSON.parse(text) as { format: string; set: string; values: object };
    assert.equal(document.format, 'jsails.config');
    assert.equal(document.set, 'site');
    assert.deepEqual(Object.keys(document.values), [
      'comments',
      'links',
      'perPage',
      'theme',
      'title',
    ]);
    const second = await exportConfig(config, dir);
    assert.deepEqual(second.written, []);
    assert.deepEqual(second.unchanged, ['site', 'mail.sender']);
  });

  it('exports active values, not overrides, and reports stale files without deleting them', async (t) => {
    const config = makeConfig({ site: { title: 'Forced' } });
    const dir = syncDir(t);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'old.json'), '{}');
    const result = await exportConfig(config, dir);
    assert.deepEqual(result.stale, ['old.json']);
    const values = (
      JSON.parse(readFileSync(join(dir, 'site.json'), 'utf8')) as { values: { title: string } }
    ).values;
    assert.equal(values.title, 'My site');
    assert.ok(readdirSync(dir).includes('old.json'));
  });
});

describe('planImport and applyImport', () => {
  it('round-trips an export into another environment', async (t) => {
    const source = makeConfig();
    await source.set(siteConfig, { title: 'Prod', perPage: 25 });
    const dir = syncDir(t);
    await exportConfig(source, dir);

    const target = makeConfig();
    const plan = await planImport(target, dir);
    assert.deepEqual(
      plan.changes.map((change) => [change.set, change.keys]),
      [['site', ['perPage', 'title']]],
    );
    await applyImport(target, plan);
    assert.equal((await target.get(siteConfig)).title, 'Prod');
    assert.deepEqual((await planImport(target, dir)).changes, []);
  });

  it('leaves a declared set with no file alone', async (t) => {
    const dir = syncDir(t);
    await exportConfig(makeConfig(), dir);
    rmSync(join(dir, 'mail.sender.json'));
    const target = makeConfig();
    await target.set(mailConfig, { from: 'keep@example.test' });
    const plan = await planImport(target, dir);
    assert.deepEqual(plan.missing, ['mail.sender']);
    await applyImport(target, plan);
    assert.equal((await target.get(mailConfig)).from, 'keep@example.test');
  });

  it('refuses the whole import on an unknown set or an invalid value, writing nothing', async (t) => {
    const dir = syncDir(t);
    const source = makeConfig();
    await source.set(siteConfig, { title: 'Changed' });
    await exportConfig(source, dir);
    writeFileSync(
      join(dir, 'zzz.json'),
      JSON.stringify({ format: 'jsails.config', version: 1, set: 'zzz', values: {} }),
    );
    const target = makeConfig();
    await assert.rejects(planImport(target, dir), rejectsWith('unknown_set'));

    writeFileSync(join(dir, 'zzz.json'), '');
    await assert.rejects(planImport(target, dir), rejectsWith('invalid_snapshot'));
    assert.equal((await target.get(siteConfig)).title, 'My site');
  });

  it('refuses an invalid value naming the set and key, not the value', async (t) => {
    const dir = syncDir(t);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'site.json'),
      JSON.stringify({
        format: 'jsails.config',
        version: 1,
        set: 'site',
        values: { perPage: 999 },
      }),
    );
    await assert.rejects(planImport(makeConfig(), dir), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.code, 'invalid_value');
      assert.equal(error.set, 'site');
      assert.equal(error.key, 'perPage');
      assert.ok(!error.message.includes('999'));
      return true;
    });
  });

  it('refuses a file whose set does not match its name, or an unknown version', async (t) => {
    const dir = syncDir(t);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'site.json'),
      JSON.stringify({ format: 'jsails.config', version: 2, set: 'site', values: {} }),
    );
    await assert.rejects(planImport(makeConfig(), dir), rejectsWith('invalid_snapshot'));
    writeFileSync(
      join(dir, 'site.json'),
      JSON.stringify({ format: 'jsails.config', version: 1, set: 'mail.sender', values: {} }),
    );
    await assert.rejects(planImport(makeConfig(), dir), rejectsWith('invalid_snapshot'));
  });

  it('plans nothing for an empty or missing directory and reports every set missing', async (t) => {
    const plan = await planImport(makeConfig(), syncDir(t));
    assert.deepEqual(plan.changes, []);
    assert.deepEqual(plan.missing, ['site', 'mail.sender']);
  });
});
