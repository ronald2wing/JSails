/**
 * Access: publicAccess branding and gate decision validation.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkDecision, isPublicAccess, isValidAccess, publicAccess } from '../src/access.js';

describe('publicAccess', () => {
  it('creates a frozen branded value that a look-alike cannot forge', () => {
    const access = publicAccess('health data is not sensitive');
    assert.deepEqual(access, { kind: 'public', reason: 'health data is not sensitive' });
    assert.ok(Object.isFrozen(access));
    assert.equal(isPublicAccess(access), true);
    assert.equal(isPublicAccess({ kind: 'public', reason: 'forged' }), false);
  });

  it('requires a reason', () => {
    assert.throws(() => publicAccess(''), TypeError);
    assert.throws(() => publicAccess('   '), TypeError);
  });

  it('accepts objects as access values', () => {
    assert.equal(isValidAccess({ policy: 'notes' }), true);
    assert.equal(isValidAccess('notes'), false);
    assert.equal(isValidAccess(null), false);
  });
});

describe('checkDecision', () => {
  it('accepts exact decisions', () => {
    assert.deepEqual(checkDecision('allow'), { kind: 'allow' });
    assert.deepEqual(checkDecision('hidden'), { kind: 'hidden' });
    assert.deepEqual(checkDecision({ challenge: ['notes:write', 'notes:write', 'admin'] }), {
      kind: 'challenge',
      scopes: ['notes:write', 'admin'],
    });
  });

  it('rejects anything else', () => {
    for (const decision of [
      true,
      'ALLOW',
      undefined,
      null,
      {},
      { challenge: [] },
      { challenge: ['has space'] },
      { challenge: ['quote"'] },
      { challenge: 'scope' },
      { challenge: [1] },
    ]) {
      assert.equal(checkDecision(decision), undefined, JSON.stringify(decision));
    }
  });
});
