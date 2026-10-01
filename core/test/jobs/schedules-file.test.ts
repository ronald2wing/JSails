import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  DEFAULT_SCHEDULES_PATH,
  loadResolvedRuntimeConfig,
  RuntimeConfigError,
} from '../../src/jobs/runtime-config.js';

const root = mkdtempSync(join(tmpdir(), 'jsails-schedules-'));

after(() => {
  rmSync(root, { recursive: true, force: true });
});

const CONFIG = `export default {
  registry: { ping: { schema: {}, handler: async () => {} } },
  adapter: {
    name: 'fake',
    createProducer: () => ({ dispatch: async () => undefined, close: async () => undefined }),
    createWorker: () => ({ close: async () => undefined }),
  },
};
`;

function writeFixture(name: string, config: string, schedulesJson?: unknown): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, 'jsails.runtime.js');
  writeFileSync(configPath, config, 'utf8');
  if (schedulesJson !== undefined) {
    writeFileSync(
      join(dir, DEFAULT_SCHEDULES_PATH),
      typeof schedulesJson === 'string' ? schedulesJson : JSON.stringify(schedulesJson),
      'utf8',
    );
  }
  return configPath;
}

describe('jsails.schedules.json autoload', () => {
  it('loads the conventional file when the runtime config omits schedules', async () => {
    const configPath = writeFixture('autoload', CONFIG, [
      { id: 'ping', job: 'ping', cron: '@daily', description: 'Ping daily' },
    ]);
    const resolved = await loadResolvedRuntimeConfig(configPath, {});
    assert.deepEqual(resolved.schedules, [
      { id: 'ping', job: 'ping', cron: '@daily', description: 'Ping daily' },
    ]);
  });

  it('prefers an explicit schedules array over the conventional file', async () => {
    const configPath = writeFixture(
      'explicit',
      `export default {
  registry: { ping: { schema: {}, handler: async () => {} } },
  schedules: [{ id: 'inline', job: 'ping', cron: '@hourly' }],
  adapter: {
    name: 'fake',
    createProducer: () => ({ dispatch: async () => undefined, close: async () => undefined }),
    createWorker: () => ({ close: async () => undefined }),
  },
};
`,
      [{ id: 'file', job: 'ping', cron: '@daily' }],
    );
    const resolved = await loadResolvedRuntimeConfig(configPath, {});
    assert.equal(resolved.schedules[0]?.id, 'inline');
  });

  it('rejects invalid JSON', async () => {
    const configPath = writeFixture('invalid-json', CONFIG, '{not json');
    await assert.rejects(
      loadResolvedRuntimeConfig(configPath, {}),
      (error) => error instanceof RuntimeConfigError && /not valid JSON/.test(error.message),
    );
  });

  it('rejects a non-array JSON value', async () => {
    const configPath = writeFixture('not-array', CONFIG, { schedules: [] });
    await assert.rejects(
      loadResolvedRuntimeConfig(configPath, {}),
      (error) => error instanceof RuntimeConfigError && /JSON array/.test(error.message),
    );
  });

  it('keeps an empty list when the file is absent', async () => {
    const configPath = writeFixture('absent', CONFIG);
    const resolved = await loadResolvedRuntimeConfig(configPath, {});
    assert.deepEqual(resolved.schedules, []);
  });
});
