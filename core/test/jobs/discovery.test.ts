import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { JobDiscoveryError, loadJobRegistryFromDirectory } from '../../src/jobs/discovery.js';

const root = mkdtempSync(join(tmpdir(), 'jsails-jobs-'));

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function fixture(name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(dir, relative);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
  return dir;
}

describe('loadJobRegistryFromDirectory', () => {
  it('loads top-level object and class jobs, deriving names from files', async () => {
    const dir = fixture('basic', {
      'send-email.job.js': `export default { schema: {}, handler: async () => {} };`,
      'digest.job.js': `export default class DigestJob { static schema = {}; async handle() {} }`,
      'explicit.job.js': `export default class Explicit { static jobName = 'billing.explicit'; static schema = {}; async handle() {} }`,
      'index.job.js': `export default {};`,
      'internal/helper.js': `export default { schema: {}, handler: async () => {} };`,
    });

    const registry = await loadJobRegistryFromDirectory(dir);
    assert.deepEqual(Object.keys(registry).sort(), ['billing.explicit', 'digest', 'sendEmail']);
    assert.equal(typeof registry.sendEmail, 'object');
    assert.equal(typeof registry.digest, 'function');
    assert.equal((registry.digest as unknown as { jobName?: string }).jobName, 'digest');
    assert.equal(
      (registry['billing.explicit'] as unknown as { jobName?: string }).jobName,
      'billing.explicit',
    );
  });

  it('returns an empty registry for a missing directory', async () => {
    assert.deepEqual(await loadJobRegistryFromDirectory(join(root, 'missing')), {});
  });

  it('rejects a malformed default export', async () => {
    const dir = fixture('invalid', {
      'bad.job.js': `export default { nope: true };`,
    });
    await assert.rejects(
      loadJobRegistryFromDirectory(dir),
      (error) => error instanceof JobDiscoveryError && error.code === 'invalid_export',
    );
  });

  it('rejects duplicate names', async () => {
    const dir = fixture('duplicate', {
      'a.job.js': `export default { name: 'dup', schema: {}, handler: async () => {} };`,
      'b.job.js': `export default { name: 'dup', schema: {}, handler: async () => {} };`,
    });
    await assert.rejects(
      loadJobRegistryFromDirectory(dir),
      (error) => error instanceof JobDiscoveryError && error.code === 'duplicate_name',
    );
  });

  it('rejects a module that cannot be imported', async () => {
    const dir = fixture('broken', {
      'broken.job.js': `export default {`,
    });
    await assert.rejects(
      loadJobRegistryFromDirectory(dir),
      (error) => error instanceof JobDiscoveryError && error.code === 'load_failed',
    );
  });
});
