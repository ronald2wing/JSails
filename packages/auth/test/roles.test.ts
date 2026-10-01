/**
 * Tests for the role helpers: `sessionRole` reads the session's `role`,
 * `requireRole` and `adminOnly` are default-deny predicates that never throw.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { adminOnly, requireRole, sessionRole } from '../src/index.js';
import { sessionWith as session } from './fixtures.js';

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
