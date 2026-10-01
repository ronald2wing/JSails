/**
 * Tests for keyset paging: cursors round-trip per listing, decoding is strict
 * (listing, key type, canonical spelling), page sizes are bounded, and a page
 * cut carries a cursor only when more rows follow.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cutPage, encodePageCursor, MAX_PAGE_LIMIT, pageWindow } from '../src/tenancy-page.js';
import { thrownCode } from './thrown-code.js';

describe('pageWindow', () => {
  it('decodes a cursor of its own listing', () => {
    assert.deepEqual(pageWindow('members', { limit: 5 }), { limit: 5, after: null });
    assert.deepEqual(
      pageWindow('members', { limit: 5, after: encodePageCursor('members', 'user-7') }),
      { limit: 5, after: 'user-7' },
    );
    assert.deepEqual(
      pageWindow('audit', { limit: MAX_PAGE_LIMIT, after: encodePageCursor('audit', 42) }),
      { limit: MAX_PAGE_LIMIT, after: 42 },
    );
  });

  it('refuses foreign, mistyped and non-canonical cursors and bad sizes', () => {
    const raw = (value: unknown): string =>
      Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    const cases: readonly [string, () => unknown][] = [
      [
        'another listing',
        () => pageWindow('invitations', { limit: 1, after: encodePageCursor('audit', 3) }),
      ],
      [
        'string key for a numeric listing',
        () => pageWindow('audit', { limit: 1, after: raw(['audit', '3']) }),
      ],
      ['zero key', () => pageWindow('audit', { limit: 1, after: raw(['audit', 0]) })],
      ['fractional key', () => pageWindow('audit', { limit: 1, after: raw(['audit', 1.5]) })],
      [
        'numeric key for a string listing',
        () => pageWindow('members', { limit: 1, after: raw(['members', 3]) }),
      ],
      ['extra element', () => pageWindow('members', { limit: 1, after: raw(['members', 'a', 1]) })],
      [
        'trailing characters',
        () =>
          pageWindow('members', {
            limit: 1,
            after: raw(['members', 'a']).replace(/=*$/, '') + 'AA',
          }),
      ],
      [
        'non-canonical JSON',
        () =>
          pageWindow('members', {
            limit: 1,
            after: Buffer.from('[ "members","a"]').toString('base64url'),
          }),
      ],
      [
        'not JSON',
        () => pageWindow('members', { limit: 1, after: Buffer.from('{').toString('base64url') }),
      ],
      [
        'padding',
        () => pageWindow('members', { limit: 1, after: `${encodePageCursor('members', 'a')}=` }),
      ],
      ['empty', () => pageWindow('members', { limit: 1, after: '' })],
      ['zero limit', () => pageWindow('members', { limit: 0 })],
      ['large limit', () => pageWindow('members', { limit: MAX_PAGE_LIMIT + 1 })],
      ['missing request', () => pageWindow('members', JSON.parse('null') as { limit: number })],
    ];
    for (const [label, call] of cases) {
      assert.equal(thrownCode(call), 'invalid_page_request', label);
    }
  });
});

describe('cutPage', () => {
  it('returns a frozen page with a cursor only when rows follow', () => {
    const more = cutPage('invitations', [1, 2, 3], 2, (row) => row);
    assert.deepEqual(more.items, [1, 2]);
    assert.equal(more.next, encodePageCursor('invitations', 2));
    assert.ok(Object.isFrozen(more) && Object.isFrozen(more.items));
    const last = cutPage('invitations', [1, 2], 2, (row) => row);
    assert.equal(last.next, null);
    assert.deepEqual(
      cutPage('invitations', [], 2, (row: number) => row),
      { items: [], next: null },
    );
  });
});
