/**
 * The version 2 update protocol parsers: every request shape the server
 * accepts or refuses, and every reply shape the controller accepts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COMPONENT_PROTOCOL_VERSION,
  MAX_HAVE_SLOTS_BYTES,
  MAX_RENDER_TAG_LENGTH,
  MAX_SLOT_COMPONENT_LENGTH,
  MAX_SLOT_LENGTH,
  MAX_UPDATE_KEYS,
  haveSlotsByteLength,
  parseUpdateRequest,
  parseUpdateResponse,
  type ComponentHeldSlot,
} from '../../src/wire/protocol.js';

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: COMPONENT_PROTOCOL_VERSION,
    sequence: 3,
    snapshot: 'a.b',
    updates: {},
    have: { render: null, slots: [] },
    ...overrides,
  };
}

describe('parseUpdateRequest', () => {
  it('accepts a minimal request and one with every member', () => {
    assert.deepEqual(parseUpdateRequest(request()), {
      ok: true,
      value: {
        v: 2,
        sequence: 3,
        snapshot: 'a.b',
        updates: {},
        have: { render: null, slots: [] },
      },
    });
    const full = request({
      updates: { title: 'x' },
      action: { name: 'save', args: { by: 1 } },
      have: { render: 'tag', slots: [{ slot: 'k:main', component: 'card' }] },
    });
    const parsed = parseUpdateRequest(full);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.ok && parsed.value, full);
  });

  it('answers protocol_mismatch for any other version, echoing a readable sequence', () => {
    for (const v of [undefined, 1, 3, '2', null]) {
      const payload = request({ v });
      assert.deepEqual(parseUpdateRequest(payload), {
        ok: false,
        reason: 'protocol_mismatch',
        sequence: 3,
      });
    }
    assert.deepEqual(parseUpdateRequest({ snapshot: 'a.b', updates: {}, sequence: -1 }), {
      ok: false,
      reason: 'protocol_mismatch',
      sequence: 0,
    });
  });

  it('refuses a malformed request', () => {
    const cases: unknown[] = [
      null,
      [],
      'text',
      request({ sequence: 1.5 }),
      request({ sequence: -1 }),
      request({ sequence: undefined }),
      request({ snapshot: '' }),
      request({ snapshot: 42 }),
      request({ updates: [] }),
      request({ updates: null }),
      request({
        updates: Object.fromEntries(
          Array.from({ length: MAX_UPDATE_KEYS + 1 }, (_, index) => [`k${index}`, 1]),
        ),
      }),
      request({ action: { name: '' } }),
      request({ action: { name: 'toString' } }),
      request({ action: { name: 'save', args: [] } }),
      request({ action: 'save' }),
      request({ children: [] }),
      request({ have: undefined }),
      request({ have: { render: null } }),
      request({ have: { render: '', slots: [] } }),
      request({ have: { render: 'x'.repeat(MAX_RENDER_TAG_LENGTH + 1), slots: [] } }),
      request({ have: { render: null, slots: {} } }),
      request({ have: { render: null, slots: [{ slot: 'k:a' }] } }),
      request({ have: { render: null, slots: [{ slot: '', component: 'card' }] } }),
      request({
        have: { render: null, slots: [{ slot: 's'.repeat(MAX_SLOT_LENGTH + 1), component: 'c' }] },
      }),
      request({
        have: {
          render: null,
          slots: [{ slot: 'k:a', component: 'c'.repeat(MAX_SLOT_COMPONENT_LENGTH + 1) }],
        },
      }),
      request({ have: { render: null, slots: [{ slot: 'k:a', component: 'c', extra: 1 }] } }),
      request({ updates: { value: Number.NaN } }),
      JSON.parse(
        '{"v":2,"sequence":1,"snapshot":"a.b","updates":{"__proto__":{}},"have":{"render":null,"slots":[]}}',
      ),
    ];
    for (const payload of cases) {
      const parsed = parseUpdateRequest(payload);
      assert.equal(parsed.ok, false, JSON.stringify(payload)?.slice(0, 120));
      assert.equal(!parsed.ok && parsed.reason, 'malformed');
    }
  });

  it('answers too_many_children over the have.slots byte cap, and accepts the cap', () => {
    const slots: ComponentHeldSlot[] = [];
    while (haveSlotsByteLength(slots) <= MAX_HAVE_SLOTS_BYTES) {
      slots.push({ slot: `k:${slots.length}`, component: 'card' });
    }
    assert.deepEqual(parseUpdateRequest(request({ have: { render: null, slots } })), {
      ok: false,
      reason: 'too_many_children',
      sequence: 3,
    });
    slots.pop();
    assert.equal(parseUpdateRequest(request({ have: { render: null, slots } })).ok, true);
  });

  it('counts the cap in UTF-8 bytes', () => {
    const slots = [{ slot: 'é', component: 'c' }];
    assert.equal(haveSlotsByteLength(slots), JSON.stringify(slots).length + 1);
  });

  it('holds 500 children of a typical slot shape', () => {
    const slots = Array.from({ length: 500 }, (_, index) => ({
      slot: `k:item-${index}`,
      component: 'task-card',
    }));
    assert.ok(haveSlotsByteLength(slots) <= MAX_HAVE_SLOTS_BYTES);
  });
});

describe('parseUpdateResponse', () => {
  it('accepts every reply kind', () => {
    const replies = [
      { kind: 'unchanged', sequence: 1 },
      { kind: 'unchanged', sequence: 1, snapshot: 'a.b' },
      { kind: 'render', sequence: 1, snapshot: 'a.b', html: '<div></div>', render: 't' },
      {
        kind: 'render',
        sequence: 1,
        snapshot: 'a.b',
        html: '',
        render: 't',
        effects: {
          redirect: '/next',
          download: { url: '/_jsails/components/download?ref=x', filename: 'a.csv' },
          refresh: ['k:main'],
        },
      },
      { kind: 'invalid', sequence: 1, errors: { title: 'Required' }, html: '', render: 't' },
      { kind: 'error', sequence: 0, error: { code: 'too_many_children', message: 'x' } },
      { kind: 'protocol_mismatch', sequence: 0, v: 2 },
    ];
    for (const reply of replies) {
      assert.deepEqual(parseUpdateResponse(reply), reply);
    }
  });

  it('refuses anything else', () => {
    const replies: unknown[] = [
      null,
      { sequence: 1, snapshot: 'a.b', html: '' },
      { kind: 'render', sequence: -1, snapshot: 'a.b', html: '', render: 't' },
      { kind: 'render', sequence: 1, snapshot: '', html: '', render: 't' },
      { kind: 'render', sequence: 1, snapshot: 'a.b', html: '' },
      { kind: 'render', sequence: 1, snapshot: 'a.b', html: '', render: 't', effects: [] },
      {
        kind: 'render',
        sequence: 1,
        snapshot: 'a.b',
        html: '',
        render: 't',
        effects: { redirect: '' },
      },
      {
        kind: 'render',
        sequence: 1,
        snapshot: 'a.b',
        html: '',
        render: 't',
        effects: { download: { url: '' } },
      },
      {
        kind: 'render',
        sequence: 1,
        snapshot: 'a.b',
        html: '',
        render: 't',
        effects: { refresh: [''] },
      },
      { kind: 'unchanged', sequence: 1, snapshot: '' },
      { kind: 'invalid', sequence: 1, errors: { title: 1 }, html: '', render: 't' },
      { kind: 'error', sequence: 1, error: { code: 'teapot', message: 'x' } },
      { kind: 'error', sequence: 1, error: { code: 'forbidden' } },
      { kind: 'protocol_mismatch', sequence: 1, v: '2' },
      { kind: 'other', sequence: 1 },
    ];
    for (const reply of replies) {
      assert.equal(parseUpdateResponse(reply), null, JSON.stringify(reply));
    }
  });
});
