/**
 * Tests for path-prefix matching: slug and rest extraction, canonical-only
 * matching, reserved slugs, and prefix validation.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { slugPolicy } from '../src/slug-policy.js';
import { assertTenantPathPrefix, matchTenantPath } from '../src/tenant-path.js';
import { thrownCode } from './thrown-code.js';

describe('matchTenantPath', () => {
  const cases: readonly (readonly [string, { slug: string; rest: string } | null])[] = [
    ['/t/acme', { slug: 'acme', rest: '/' }],
    ['/t/acme/', { slug: 'acme', rest: '/' }],
    ['/t/acme/projects/7', { slug: 'acme', rest: '/projects/7' }],
    ['/t/acme//x', { slug: 'acme', rest: '//x' }],
    ['/t', null],
    ['/t/', null],
    ['/tx/acme', null],
    ['/x/t/acme', null],
    ['//t/acme', null],
    ['/t/Acme', null],
    ['/t/%61cme', null],
    ['/t/ac--me', null],
    ['/t/ab', null],
    ['/t/www/x', null],
    ['/t/123', null],
    ['', null],
  ];
  for (const [pathname, expected] of cases) {
    it(`matches ${JSON.stringify(pathname)}`, () => {
      assert.deepEqual(matchTenantPath(pathname, '/t'), expected);
    });
  }

  it('supports multi-segment prefixes and a custom policy', () => {
    assert.deepEqual(matchTenantPath('/app/org/acme/x', '/app/org'), { slug: 'acme', rest: '/x' });
    assert.equal(matchTenantPath('/t/pricing', '/t', slugPolicy({ reserved: ['pricing'] })), null);
  });

  it('refuses a malformed prefix with invalid_path_prefix', () => {
    for (const prefix of ['/', '/t/', 't', '/T', '/t//x', '/t?x', '/-t'] as const) {
      assert.equal(
        thrownCode(() => matchTenantPath('/t/acme', prefix as `/${string}`)),
        'invalid_path_prefix',
        prefix,
      );
    }
    assert.doesNotThrow(() => assertTenantPathPrefix('/workspaces'));
  });
});
