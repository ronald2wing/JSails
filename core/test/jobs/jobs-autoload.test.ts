import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { loadResolvedRuntimeConfig } from '../../src/jobs/runtime-config.js';

const root = mkdtempSync(join(tmpdir(), 'jsails-jobs-config-'));

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function fixture(name: string, config: string, jobs: Record<string, string> = {}): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'jobs'), { recursive: true });
  for (const [relative, content] of Object.entries(jobs)) {
    writeFileSync(join(dir, 'jobs', relative), content, 'utf8');
  }
  const configPath = join(dir, 'jsails.runtime.js');
  writeFileSync(configPath, config, 'utf8');
  return configPath;
}

const ADAPTER = `adapter: {
  name: 'fake',
  createProducer: () => ({ dispatch: async () => undefined, close: async () => undefined }),
  createWorker: () => ({ close: async () => undefined }),
}`;

describe('runtime config job autoload', () => {
  it('loads the registry from jobsDir when registry is omitted', async () => {
    const configPath = fixture('autoload', `export default { jobsDir: './jobs', ${ADAPTER} };`, {
      'send-email.job.js': `export default { schema: {}, handler: async () => {} };`,
      'digest.job.js': `export default class DigestJob { static schema = {}; async handle() {} }`,
    });
    const resolved = await loadResolvedRuntimeConfig(configPath, {});
    assert.deepEqual(Object.keys(resolved.registry).sort(), ['digest', 'sendEmail']);
  });

  it('prefers an explicit registry over jobsDir', async () => {
    const configPath = fixture(
      'explicit',
      `export default {
  jobsDir: './jobs',
  registry: { inline: { schema: {}, handler: async () => {} } },
  ${ADAPTER}
};`,
      {
        'file.job.js': `export default { name: 'file', schema: {}, handler: async () => {} };`,
      },
    );
    const resolved = await loadResolvedRuntimeConfig(configPath, {});
    assert.deepEqual(Object.keys(resolved.registry), ['inline']);
  });

  it('uses an empty registry when jobsDir is missing', async () => {
    const configPath = fixture(
      'missing',
      `export default { jobsDir: './does-not-exist', ${ADAPTER} };`,
    );
    const resolved = await loadResolvedRuntimeConfig(configPath, {});
    assert.deepEqual(resolved.registry, {});
  });

  it('rejects an empty jobsDir', async () => {
    const configPath = fixture('invalid', `export default { jobsDir: '   ', ${ADAPTER} };`);
    await assert.rejects(
      loadResolvedRuntimeConfig(configPath, {}),
      /jobsDir must be a non-empty string/,
    );
  });
});
