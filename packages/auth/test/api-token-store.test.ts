/**
 * Tests for the Better Auth token store: it mints a tagged session whose
 * secret is returned exactly once, lists only token sessions (no secrets),
 * revokes by id, and resolves only live token credentials.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createBetterAuthApiTokenStore } from '../src/api-token-store.js';
import { fakeAuthWithSessions, USER_ID } from './fixtures.js';

describe('createBetterAuthApiTokenStore', () => {
  it('mints a tagged session and returns the secret exactly once', async () => {
    const { auth, sessions } = fakeAuthWithSessions();
    const store = createBetterAuthApiTokenStore(auth);

    const created = await store.create(USER_ID, 'ci', new Date(Date.now() + 30 * 86_400_000));

    assert.equal(created.name, 'ci');
    assert.equal(created.id, 'session-1');
    assert.equal(created.token, 'token-1');
    assert.ok(created.expiresAt > created.createdAt);

    // The backing session carries the sentinel plus the name, never the secret.
    const row = sessions.get(created.token);
    assert.ok(row);
    assert.equal(row.userAgent, 'jsails/api-token:ci');
  });

  it('lists only token sessions, without exposing secrets', async () => {
    const { auth, adapter } = fakeAuthWithSessions();
    const store = createBetterAuthApiTokenStore(auth);

    // A browser session (no sentinel) must be excluded.
    await adapter.createSession(USER_ID, undefined, { userAgent: 'Mozilla/5.0' });
    const created = await store.create(USER_ID, 'ci', new Date(Date.now() + 86_400_000));

    const list = await store.list(USER_ID);
    assert.deepEqual(list, [
      { id: created.id, name: 'ci', createdAt: created.createdAt, expiresAt: created.expiresAt },
    ]);
    // The secret never appears on the listed shape.
    assert.ok(!Object.prototype.hasOwnProperty.call(list[0], 'token'));
  });

  it('revokes by id and reports a missing id', async () => {
    const { auth } = fakeAuthWithSessions();
    const store = createBetterAuthApiTokenStore(auth);

    const created = await store.create(USER_ID, 'ci', new Date(Date.now() + 86_400_000));

    assert.equal(await store.revoke(USER_ID, created.id), true);
    assert.equal(await store.revoke(USER_ID, created.id), false);
    assert.equal(await store.resolve(created.token), null);
  });

  it('resolves a live token but rejects expired or non-token sessions', async () => {
    const { auth, adapter } = fakeAuthWithSessions();
    const store = createBetterAuthApiTokenStore(auth);

    const live = await store.create(USER_ID, 'ci', new Date(Date.now() + 86_400_000));
    const expired = await adapter.createSession(USER_ID, undefined, {
      userAgent: 'jsails/api-token:old',
      expiresAt: new Date(Date.now() - 1000),
    });
    const browser = await adapter.createSession(USER_ID, undefined, { userAgent: 'Mozilla/5.0' });

    const resolved = await store.resolve(live.token);
    assert.ok(resolved);
    assert.equal(resolved.userId, USER_ID);
    assert.equal(resolved.name, 'Ada');
    assert.equal(resolved.email, 'ada@example.com');

    assert.equal(await store.resolve(expired.token), null);
    // A browser session's token is not a valid API-token credential.
    assert.equal(await store.resolve(browser.token), null);
    assert.equal(await store.resolve('missing'), null);
  });
});
