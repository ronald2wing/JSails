/**
 * The memory lease table: one owner per key until its TTL, owner-checked
 * renew and release, expiry on the adapter's clock, and value-free refusals
 * of malformed arguments as rejections.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MAX_OVERLAP_TTL_MS, MIN_OVERLAP_TTL_MS } from '../../src/envelope/job-options.js';
import { JobsErrors } from '../../src/errors/jobs-errors.js';
import { LeaseTable } from '../../src/memory/lease-table.js';
import { MAX_LEASE_KEY_LENGTH } from '../../src/overlap/lease-bounds.js';
import { VirtualClock } from '../timing/virtual-clock.js';

const refused = (option: string) => (error: unknown) =>
  JobsErrors.is(error, 'invalid_option') && error.context.option === option;

describe('lease table', () => {
  test('one owner per key until the TTL ends', async () => {
    const clock = new VirtualClock(0);
    const table = new LeaseTable(clock);
    const token = await table.acquire('k', 1_000);
    assert.equal(typeof token, 'string');
    assert.equal(await table.acquire('k', 1_000), undefined);
    assert.equal(typeof (await table.acquire('other', 1_000)), 'string');
    await clock.advance(1_000);
    const next = await table.acquire('k', 1_000);
    assert.ok(next !== undefined && next !== token);
  });

  test('renew and release check the owner and the expiry', async () => {
    const clock = new VirtualClock(0);
    const table = new LeaseTable(clock);
    const token = (await table.acquire('k', 1_000))!;
    assert.equal(await table.renew('k', 'not-mine', 1_000), false);
    assert.equal(await table.release('k', 'not-mine'), false);
    await clock.advance(900);
    assert.equal(await table.renew('k', token, 2_000), true);
    await clock.advance(1_500);
    assert.equal(await table.acquire('k', 1_000), undefined, 'the renewal extended the lease');
    assert.equal(await table.release('k', token), true);
    assert.equal(typeof (await table.acquire('k', 1_000)), 'string');
    await clock.advance(1_000);
    assert.equal(await table.renew('k', token, 1_000), false);
    assert.equal(await table.renew('missing', token, 1_000), false);
  });

  test('refuses malformed arguments as rejections', async () => {
    const table = new LeaseTable(new VirtualClock(0));
    for (const key of ['', 'k'.repeat(MAX_LEASE_KEY_LENGTH + 1), 7]) {
      await assert.rejects(table.acquire(key as string, 1_000), refused('key'));
    }
    for (const ttl of [MIN_OVERLAP_TTL_MS - 1, MAX_OVERLAP_TTL_MS + 1, 1.5, '1000']) {
      await assert.rejects(table.acquire('k', ttl as number), refused('ttlMs'));
      await assert.rejects(table.renew('k', 't', ttl as number), refused('ttlMs'));
    }
    for (const token of ['', 't'.repeat(129), 7]) {
      await assert.rejects(table.renew('k', token as string, 1_000), refused('token'));
      await assert.rejects(table.release('k', token as string), refused('token'));
    }
    await assert.rejects(table.release('', 't'), refused('key'));
    await assert.rejects(table.renew('', 't', 1_000), refused('key'));
  });
});
