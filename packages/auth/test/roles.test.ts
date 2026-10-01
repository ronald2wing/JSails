/**
 * Tests for the role helpers: `sessionRole` reads the session's `role`,
 * `requireRole` and `adminOnly` are default-deny predicates that never throw.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Auth } from '../src/better-auth.js';
import { adminOnly, requireRole, sessionRole, setUserRole } from '../src/index.js';
import { requestContext, sessionWith as session } from './fixtures.js';

describe('role helpers', () => {
  it('sessionRole reads the role field and falls back to null', () => {
    assert.equal(sessionRole(session({ role: 'admin' })), 'admin');
    assert.equal(sessionRole(session({})), null);
    assert.equal(sessionRole(session({ role: 42 })), null);
    assert.equal(sessionRole(null), null);
  });

  it('requireRole allows only the named roles and never throws', () => {
    const gate = requireRole('admin', 'editor');
    assert.equal(gate(session({ role: 'admin' })), true);
    assert.equal(gate(session({ role: 'editor' })), true);
    assert.equal(gate(session({ role: 'viewer' })), false);
    assert.equal(gate(session({})), false);
    assert.equal(gate(null), false);
  });

  it('adminOnly allows only the admin role', () => {
    assert.equal(adminOnly(session({ role: 'admin' })), true);
    assert.equal(adminOnly(session({ role: 'viewer' })), false);
    assert.equal(adminOnly(null), false);
  });
});

describe('role helpers with a request context', () => {
  it('read the role from context.session, as the documented page example passes it', () => {
    assert.equal(sessionRole(requestContext(session({ role: 'admin' }))), 'admin');
    assert.equal(adminOnly(requestContext(session({ role: 'admin' }))), true);
    assert.equal(adminOnly(requestContext(null)), false);
    assert.equal(requireRole('editor')(requestContext(session({ role: 'viewer' }))), false);
  });
});

describe('setUserRole', () => {
  function fakeUsers() {
    const roles = new Map<string, string | null>([['u1', null]]);
    const auth = {
      $context: Promise.resolve({
        internalAdapter: {
          findUserByEmail: async (email: string) =>
            email === 'ada@example.com' ? { user: { id: 'u1' } } : null,
          updateUser: async (id: string, data: { role: string | null }) => {
            roles.set(id, data.role);
          },
        },
      }),
    } as unknown as Auth;
    return { auth, roles };
  }

  it('assigns and clears a role by normalized email', async () => {
    const { auth, roles } = fakeUsers();
    assert.equal(await setUserRole(auth, ' Ada@Example.com ', 'admin'), true);
    assert.equal(roles.get('u1'), 'admin');
    assert.equal(await setUserRole(auth, 'ada@example.com', null), true);
    assert.equal(roles.get('u1'), null);
  });

  it('reports an unknown email and rejects an empty role', async () => {
    const { auth } = fakeUsers();
    assert.equal(await setUserRole(auth, 'nobody@example.com', 'admin'), false);
    await assert.rejects(setUserRole(auth, 'ada@example.com', ' '), TypeError);
  });
});
