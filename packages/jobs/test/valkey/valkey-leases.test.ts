/**
 * Owner-token leases on the Valkey transport over a fake BullMQ, whose
 * script replies stand for the server: each operation is one script on the
 * lease's own key with the holder's token, and a bad key, token or TTL is
 * refused before any script runs. The server's side is pinned live.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fakeAdapter, refused } from './fixtures/fake-adapter.js';

test('acquire hands out a fresh token only when the key was free', async () => {
  const { backend, adapter } = await fakeAdapter();
  const leases = adapter.capabilities.leases!;
  backend.scriptReply = () => 1;
  const token = await leases.acquire('nightly', 5_000);
  assert.equal(typeof token, 'string');
  const call = backend.scriptCalls[0]!;
  assert.equal(call.script, 'leaseAcquire');
  assert.deepEqual(call.keys, ['app:test:jobs:_lease:nightly']);
  assert.deepEqual(call.args, [token, 5_000]);
  assert.notEqual(await leases.acquire('nightly', 5_000), token);
  backend.scriptReply = () => 0;
  assert.equal(await leases.acquire('nightly', 5_000), undefined);
  await adapter.close();
});

test('renew and release compare the token on the server', async () => {
  const { backend, adapter } = await fakeAdapter();
  const leases = adapter.capabilities.leases!;
  backend.scriptReply = () => 1;
  assert.equal(await leases.renew('nightly', 'token-1', 2_000), true);
  assert.equal(await leases.release('nightly', 'token-1'), true);
  assert.deepEqual(
    backend.scriptCalls.map((call) => [call.script, call.keys[0], ...call.args]),
    [
      ['leaseRenew', 'app:test:jobs:_lease:nightly', 'token-1', 2_000],
      ['leaseRelease', 'app:test:jobs:_lease:nightly', 'token-1'],
    ],
  );
  backend.scriptReply = () => 0;
  assert.equal(await leases.renew('nightly', 'token-2', 2_000), false);
  assert.equal(await leases.release('nightly', 'token-2'), false);
  await adapter.close();
});

test('a bad key, token or TTL is refused before any script', async () => {
  const { backend, adapter } = await fakeAdapter();
  const leases = adapter.capabilities.leases!;
  await assert.rejects(leases.acquire('', 5_000), refused('invalid_option', { option: 'key' }));
  await assert.rejects(leases.acquire('k', 10), refused('invalid_option', { option: 'ttlMs' }));
  await assert.rejects(
    leases.renew('k', '', 5_000),
    refused('invalid_option', { option: 'token' }),
  );
  await assert.rejects(leases.release('k', ''), refused('invalid_option', { option: 'token' }));
  assert.deepEqual(backend.scriptCalls, []);
  await adapter.close();
});
