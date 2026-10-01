/** Tests for the dispatch recorder test double. */

import assert from 'node:assert/strict';
import { AssertionError } from 'node:assert';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { createFakeJobs } from '../../src/jobs/fake-jobs.js';
import {
  createJobRegistry,
  defineJob,
  JobNotRegisteredError,
  JobPayloadError,
} from '../../src/jobs/registry.js';

const registry = createJobRegistry({
  welcome: defineJob(z.object({ to: z.string() }), () => undefined),
});

describe('createFakeJobs', () => {
  it('records dispatches and asserts over them', async () => {
    const jobs = createFakeJobs();
    jobs.assertNothingDispatched();
    await jobs.dispatch('welcome', { to: 'a@example.com' });
    await jobs.dispatch('welcome', { to: 'b@example.com' }, { delay: 10 });

    jobs.assertDispatched('welcome');
    jobs.assertDispatched(
      'welcome',
      (payload) => (payload as { to: string }).to === 'b@example.com',
    );
    jobs.assertDispatchedTimes('welcome', 2);
    jobs.assertNotDispatched('charge');
    assert.deepEqual(jobs.dispatchesOf('welcome')[1], {
      name: 'welcome',
      payload: { to: 'b@example.com' },
      options: { delay: 10 },
    });

    assert.throws(() => jobs.assertDispatched('charge'), AssertionError);
    assert.throws(() => jobs.assertDispatchedTimes('welcome', 1), AssertionError);
    assert.throws(() => jobs.assertNotDispatched('welcome'), AssertionError);
    assert.throws(() => jobs.assertNothingDispatched(), AssertionError);

    jobs.clear();
    jobs.assertNothingDispatched();
  });

  it('validates dispatches like the runtime when given a registry', async () => {
    const jobs = createFakeJobs({ registry });
    await assert.rejects(jobs.dispatch('ghost', {}), JobNotRegisteredError);
    await assert.rejects(jobs.dispatch('welcome', { to: 1 }), JobPayloadError);
    await assert.rejects(jobs.dispatch('welcome', { to: 'a' }, { bogus: true }), /unsupported/);
    assert.equal(jobs.dispatched.length, 0);
  });
});
