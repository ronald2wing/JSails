/**
 * Tests for the jobs stage of `scripts/verify-integrations.mjs`: it runs the
 * `@jsails/jobs` suite through the reconciling runner with the live BullMQ
 * conformance file enabled and the `valkey` service declared, which is what
 * makes the Valkey-scoped entries of `scripts/expected-failures/jobs.json`
 * apply.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { applies, declaredServices, readLedgers } from '../expected-failures.mjs';
import { jobsSuiteRun } from '../verify-integrations.mjs';
import { repoRoot } from '../workspaces.mjs';

const URL = 'redis://127.0.0.1:6379';

describe('jobsSuiteRun', () => {
  it('runs the jobs workspace through run-tests with the live file enabled', () => {
    const run = jobsSuiteRun({ PATH: '/bin' }, URL);
    assert.equal(run.command, process.execPath);
    assert.deepEqual(run.args, [join(repoRoot, 'scripts', 'run-tests.mjs')]);
    assert.equal(run.cwd, join(repoRoot, 'packages', 'jobs'));
    assert.equal(run.env.PATH, '/bin');
    assert.equal(run.env.VALKEY_URL, URL);
    assert.equal(run.env.JSAILS_TEST_VALKEY, '1');
    assert.deepEqual(declaredServices(run.env.JSAILS_TEST_SERVICES), ['valkey']);
  });

  it('adds valkey to services the caller already declared, once, without changing its env', () => {
    const env = { JSAILS_TEST_SERVICES: 'valkey' };
    assert.equal(jobsSuiteRun(env, URL).env.JSAILS_TEST_SERVICES, 'valkey');
    assert.deepEqual(env, { JSAILS_TEST_SERVICES: 'valkey' });
  });

  it('declares what the Valkey-scoped jobs entries need, and they apply only then', () => {
    const scoped = readLedgers()
      .filter((ledger) => ledger.name === 'jobs')
      .flatMap((ledger) => ledger.entries)
      .filter((entry) => entry.services !== undefined);
    assert.ok(scoped.length > 0, 'jobs.json lists Valkey-scoped entries');
    const services = declaredServices(jobsSuiteRun({}, URL).env.JSAILS_TEST_SERVICES);
    for (const entry of scoped) {
      assert.match(entry.file, /^packages\/jobs\/test\//);
      assert.equal(applies(entry, { platform: 'linux', database: 'sqlite', services }), true);
      assert.equal(applies(entry, { platform: 'linux', database: 'sqlite', services: [] }), false);
    }
  });
});
